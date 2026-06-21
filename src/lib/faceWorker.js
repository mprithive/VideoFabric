/* eslint-disable no-restricted-globals */
/**
 * faceWorker.js — Web Worker for parallel AI-powered face effect processing
 *
 * Uses @mediapipe/tasks-vision FaceLandmarker which runs entirely in Web Workers
 * via WebAssembly (no DOM, no window required).
 *
 * Pipeline per frame:
 *   receive small detect bitmap  →  FaceLandmarker.detectForVideo()
 *   →  return lightweight overlay metadata to main thread
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// ─── Worker state ─────────────────────────────────────────────────────────────
let faceLandmarker = null;
let detectCtx = null;   // small OffscreenCanvas — used ONLY for inference
let workerWidth = 0;
let workerHeight = 0;
let cachedLandmarks = null;
let cachedInferenceFrameIndex = Number.NEGATIVE_INFINITY;

// ─── Message dispatcher ───────────────────────────────────────────────────────
self.onmessage = async (event) => {
	const { type, payload } = event.data;
	try {
		switch (type) {
			case 'INIT':      await handleInit(payload);        break;
			case 'PROCESS_BATCH': await handleProcessBatch(payload); break;
			case 'TERMINATE': handleTerminate(); break;
			default: break;
		}
	} catch (error) {
		self.postMessage({ type: 'ERROR', error: { message: error.message, stack: error.stack } });
	}
};

// ─── Initialise ───────────────────────────────────────────────────────────────
async function handleInit({ width, height, wasmBasePath, delegate = 'GPU' }) {
	workerWidth = width;
	workerHeight = height;
	cachedLandmarks = null;
	cachedInferenceFrameIndex = Number.NEGATIVE_INFINITY;

	// Small detect canvas — AI inference runs here (9× fewer pixels than 1080p)
	// FaceLandmarker returns normalised landmarks (0-1), so resolution doesn't
	// affect landmark accuracy — only inference speed.
	const DETECT_W = 512;
	const DETECT_H = Math.round(DETECT_W * height / width);
	const detectOffscreen = new OffscreenCanvas(DETECT_W, DETECT_H);
	detectCtx = detectOffscreen.getContext('2d');

	try {
		// Use locally-served wasm files (public/mediapipe-wasm/) — no CDN dependency.
		// wasmBasePath is passed from the main thread as window.location.origin + '/mediapipe-wasm'.
		const filesetResolver = await FilesetResolver.forVisionTasks(wasmBasePath);

		faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
			baseOptions: {
				// Model is ~4 MB, downloaded once and browser-cached.
				modelAssetPath:
					'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
				// Multiple workers competing for one GPU usually serialize throughput.
				// CPU delegate scales better across workers because each worker gets its
				// own core instead of contending for the same GPU queue.
				delegate,
			},
			runningMode: 'VIDEO',
			numFaces: 1,
			outputFaceBlendshapes: false,
			outputFacialTransformationMatrixes: false,
		});

		console.log(`faceWorker: FaceLandmarker ready (${delegate}, ${DETECT_W}w, VIDEO mode)`);
	} catch (err) {
		// AI init failure is non-fatal — frames are passed through without effects
		console.warn('faceWorker: FaceLandmarker init failed, running without AI:', err.message);
		faceLandmarker = null;
	}

	self.postMessage({ type: 'INIT_COMPLETE', ready: true });
}

// ─── Batch processing ─────────────────────────────────────────────────────────
async function handleProcessBatch({ frames, width, height, inferenceStride = 1 }) {
	const processedFrames = [];

	for (const { frameIndex, detectBitmap, timestamp } of frames) {
		// AI inference + draw effects
		if (faceLandmarker) {
			try {
				const shouldInfer = Boolean(detectBitmap) && (!cachedLandmarks || (frameIndex - cachedInferenceFrameIndex) >= inferenceStride);
				if (shouldInfer && detectBitmap) {
					// Downscale to the small detect canvas for inference.
					// Normalised landmarks (0-1) are resolution-independent, so we can run
					// tracking on a much smaller frame and still draw full-resolution effects.
					detectCtx.clearRect(0, 0, detectCtx.canvas.width, detectCtx.canvas.height);
					detectCtx.drawImage(detectBitmap, 0, 0, detectCtx.canvas.width, detectCtx.canvas.height);
					const result = faceLandmarker.detectForVideo(detectCtx.canvas, timestamp);
					cachedInferenceFrameIndex = frameIndex;
					cachedLandmarks = result.faceLandmarks && result.faceLandmarks.length > 0
						? result.faceLandmarks[0]
						: null;
				}
			} catch (e) {
				// Frame returned as-is if inference throws
			}
		}

		if (detectBitmap) {
			detectBitmap.close(); // release GPU memory after all consumers are done
		}

		processedFrames.push({
			frameIndex,
			hasFace: Boolean(cachedLandmarks),
			landmarks: cachedLandmarks,
			timestamp,
		});
	}

	self.postMessage(
		{ type: 'PROCESS_BATCH_COMPLETE', payload: { processedFrames } },
	);
}

// ─── Terminate ────────────────────────────────────────────────────────────────
function handleTerminate() {
	if (faceLandmarker) {
		try { faceLandmarker.close(); } catch (_) {}
		faceLandmarker = null;
	}
	cachedLandmarks = null;
	cachedInferenceFrameIndex = Number.NEGATIVE_INFINITY;
	self.postMessage({ type: 'TERMINATED' });
}
