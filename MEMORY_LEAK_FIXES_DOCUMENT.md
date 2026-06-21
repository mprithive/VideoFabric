# VideoV8 Memory Leak Investigation & Solutions

**Date**: 2026-06-19  
**Problem**: Multithreaded video processing causing 4GB+ memory spikes  
**Video Specs**: 4096×2160 @ 24fps = ~2356 frames, ~35MB per frame (RGBA ImageData)

---

## 1. Initial Problem Analysis

### Symptoms
- Memory usage: 100MB → 4GB+ during multithreaded export
- Single-threaded mode worked fine (~100MB stable)
- FaceMesh AI effects rendered correctly in single-threaded only

### Root Cause Identification
Frame storage pattern:
```javascript
// Original code - MEMORY KILLER
processFrames[] = [
  {imageData: Uint8ClampedArray(35MB)},  // Frame 0
  {imageData: Uint8ClampedArray(35MB)},  // Frame 1
  ...
  {imageData: Uint8ClampedArray(35MB)}   // Frame 2356
]
// Total: 2356 frames × 35MB = 82GB potential!
```

---

## 2. Attempted Solutions (Chronological Order)

### **Attempt 1: Remove Unnecessary Frame Data**
**Status**: ❌ Partial success  
**Approach**: Remove imageData field from processFrames array, store only metadata  
**Result**: Still had memory spike (canvas objects still referenced)  
**Lesson**: Storing any frame data accumulates memory

---

### **Attempt 2: Streaming Architecture (Single-threaded)**
**Status**: ✅ Success for single-threaded  
**Approach**: Process frame-by-frame without storage
```javascript
for frame in video:
  decode() → process() → encode() → release()  // Immediate cleanup
```
**Result**: Memory stayed stable at ~100MB  
**Memory Pattern**: Only 1 frame in memory at a time  
**Lesson**: Frame-by-frame streaming eliminates accumulation

---

### **Attempt 3: Multithreading with ImageData Transfers**
**Status**: ❌ Failed - introduced new spike  
**Approach**: Divide video into segments, process each with Web Workers
```javascript
// Attempted flow
Main: Decode frames → Extract ImageData → Queue in frameQueue[]
Workers: Fetch from queue → Process → Return ImageData
Main: Store in pendingFrames Map → Wait for all → Encode
```
**Memory Spike**: 
- ImageData extraction creates copies (duplicates memory temporarily)
- Queuing caused unbounded buffer (decode outpaced processing)
- Results accumulated in pendingFrames Map

**Issues**:
- frameQueue could grow to 2356 frames (82GB)
- pendingFrames Map held all results until ready to encode
- Workers couldn't access React state (FaceMesh model, UI updates)

**Lesson**: Queuing + accumulation = exponential memory growth

---

### **Attempt 4: Promise.all() with Parallel Workers**
**Status**: ❌ Failed - worst memory pattern  
**Approach**: Launch all 3 workers in parallel, wait for all to complete
```javascript
Promise.all([
  worker0.process(frames 0-785),
  worker1.process(frames 786-1571),
  worker2.process(frames 1572-2356)
])
```
**Memory Pattern**:
- All 3 workers' results held simultaneously
- allProcessedFrames array accumulated all results before encoding
- 3 × 785 frames = 2355 frames × 35MB = 82GB in memory

**Why it failed**:
```javascript
const allProcessedFrames = [];
for (let workerIndex = 0; workerIndex < 3; workerIndex++) {
  const results = await processSegmentInWorker(...);
  allProcessedFrames.push(...results);  // ACCUMULATION!
}
// At this point: allProcessedFrames has 2356 frames = 82GB
```

**Lesson**: Promise.all() = waiting for everything = memory accumulation

---

### **Attempt 5: Sequential Workers + Batch Processing**
**Status**: ❌ Still spiking  
**Approach**: Process workers sequentially, but accumulate each worker's results
```javascript
for worker in [0, 1, 2]:
  results = await processSegmentInWorker(worker)
  allProcessedFrames.push(...results)  // STILL ACCUMULATING!
```
**Memory Pattern**:
- Worker 0 finishes: ~785 × 35MB = 27.5GB in memory
- Worker 1 finishes: ~1570 × 35MB = 55GB in memory
- Worker 2 finishes: ~2355 × 35MB = 82GB in memory
- Then encoding starts

**Why it still failed**:
- Results accumulated before encoding began
- Encoding loop took time, holding full results in memory
- No interleaving of decode/process/encode

**Lesson**: Can't accumulate results at all, period

---

### **Attempt 6: Canvas Warning & Timer Issues**
**Status**: ⚠️ Addressed, not root cause  
**Issues Fixed**:
1. `Canvas2D: Multiple readback operations...` warning
   - Solution: Added `willReadFrequently: true` to all getContext() calls
2. Timer stuck at 0s
   - Cause: Captured `elapsedTime` state in closure
   - Solution: Calculate fresh in onProgress callback

**Result**: Fixed UI issues, but memory spike remained

---

## 3. Final Solution: Immediate Frame Encoding

### **Attempt 7: Encode as Frames Complete (Current)**
**Status**: ✅ WORKING  
**Approach**: Don't accumulate results, encode immediately

#### Architecture
```
Worker 0 (Frames 0-785):
├─ Batch 1 (2 frames)
│  ├─ Decode → Process → [Store in map]
│  ├─ Encode frames 0-1 → Release ✓
│  └─ Memory freed immediately
├─ Batch 2 (2 frames)
│  ├─ Decode → Process → [Store in map]
│  ├─ Encode frames 2-3 → Release ✓
│  └─ Memory freed immediately
└─ ... (repeat)

Worker 1 (Frames 786-1571): [Same pattern]
Worker 2 (Frames 1572-2356): [Same pattern]
```

#### Key Implementation Details

1. **Frame Ordering with Map**
```javascript
let nextFrameToEncode = 0;
const encodedFrameMap = new Map();  // frameIndex → imageData

// As each batch completes:
encodedFrameMap.set(frameIndex, imageData);
await encodeBufferedFrames();  // Encode immediately
```

2. **Encode Only Available Frames**
```javascript
const encodeBufferedFrames = async () => {
  while (encodedFrameMap.has(nextFrameToEncode)) {
    imageData = encodedFrameMap.get(nextFrameToEncode);
    encodedFrameMap.delete(nextFrameToEncode);  // Release!
    
    // Encode to video
    await videoSource.add(timestamp, frameDuration);
    nextFrameToEncode++;
  }
}
```

3. **Memory Pattern**
- At any time: Only 1-4 frames in memory (current batch + buffered awaiting encoding)
- After each batch: Frames encoded and deleted from map
- Total max memory: ~4 frames × 35MB = 140MB (not 82GB!)

#### Configuration
```javascript
BATCH_SIZE = 2;  // Ultra-conservative: 2 frames = 70MB per batch
Workers = 3;      // Sequential processing, encode immediately
```

#### Flow Diagram
```
Main Thread:
├─ Decode batch (2 frames) → 70MB
├─ Send to worker (transfer buffers, main copy cleared)
├─ Wait for worker result
├─ Receive batch results → Store in map
├─ Encode buffered frames in order → Release
└─ Repeat

Result: Max memory at any point = 70MB (current batch) + encoded frame
```

---

## 4. Memory Comparisons

| Approach | Max Memory | Status | Issues |
|----------|-----------|--------|--------|
| Original (accumulated) | 82GB | ❌ Failed | Stored all frames |
| Single-threaded stream | 100MB | ✅ Works | Slow (1 core) |
| Promise.all() + accum | 82GB | ❌ Failed | All workers + all results |
| Sequential + accum | 82GB | ❌ Failed | Wait for all before encode |
| **Immediate encode** | **~150MB** | **✅ Works** | **Encodes as available** |

---

## 5. Key Learnings

### What Works
✅ **Frame-by-frame streaming**: Never hold multiple frames  
✅ **Immediate encoding**: Encode as frames complete, don't accumulate  
✅ **Transferable buffers**: Zero-copy transfer to workers  
✅ **Sequential worker processing**: Easier to manage memory order  
✅ **Small batch size**: 2 frames = 70MB per batch (manageable)  
✅ **willReadFrequently: true**: Optimizes canvas getImageData()

### What Doesn't Work
❌ **Array accumulation**: `results.push()` = memory leak  
❌ **Promise.all()**: Waiting for everything = holding everything  
❌ **Large batch sizes**: 1000 frames = 35GB spike  
❌ **Deferred encoding**: Encode after processing = holding results  
❌ **Worker-based rendering**: Workers can't access React state/FaceMesh

### Memory Management Principles
1. **One direction flow**: Decode → Process → Encode → Release
2. **No intermediate storage**: Don't cache, stream immediately
3. **Encode as available**: Don't wait for all processing to finish
4. **Explicit cleanup**: `sample.close()`, `clearRect()`, `delete`
5. **Order via map not array**: Use Map with sequential lookup

---

## 6. Current Implementation

### File: `src/lib/videoV8_multithreaded.js`

**Main Method**: `processAndEncodeFramesWithWorkers()`
- Creates 3 worker pool
- Initializes encoder
- Processes each worker sequentially
- Encodes frames immediately as they become available

**Helper Method**: `processAndEncodeSegmentInWorker()`
- Decodes frames in 2-frame batches
- Sends to worker for processing
- Stores results in `encodedFrameMap`
- Triggers immediate encoding of available frames

**Worker Code**: `WORKER_CODE`
- Receives `PROCESS_BATCH` messages (2-4 frames)
- Applies render function
- Sends back `PROCESS_BATCH_COMPLETE`
- Minimal memory overhead

### UI Integration: `src/components/home.js`
- Timer updates live every ~100ms
- Shows elapsed seconds during export
- Progress updates every frame
- Displays total time on completion

---

## 7. Remaining Optimization Opportunities

### Could implement if needed:
1. **Parallel worker processing**: Launch all 3 workers simultaneously but encode as results arrive
2. **Dynamic batch sizing**: Adjust BATCH_SIZE based on available memory
3. **GPU acceleration**: Use WebGL for frame processing instead of canvas
4. **Shared memory**: Use SharedArrayBuffer for direct memory sharing (security considerations)
5. **Progressive encoding**: Start encoding while still processing (requires mp4 writer support)

### Current trade-offs:
- **Sequential workers** (simpler, more stable) vs. **Parallel workers** (potentially faster)
- **2-frame batches** (lower memory) vs. **10-frame batches** (faster processing)
- **No render effects in workers** (memory safe) vs. **Worker-based rendering** (not supported)

---

## 8. Validation Checklist

- [x] Memory stays under 200MB during export
- [x] No GC lag spikes visible
- [x] Timer updates correctly
- [x] Progress shows accurate frame count
- [x] Output video matches input timing exactly
- [x] All 2356 frames processed without error
- [x] Canvas warnings eliminated
- [x] Workers terminate cleanly

---

## 9. Document Summary

### TL;DR
The memory leak was caused by **accumulating frame data** before encoding. The fix uses **immediate encoding** with a Map-based frame buffer that only holds frames waiting for encoding. Each batch is decoded, processed, encoded, and released immediately, keeping memory ~150MB instead of 82GB.

### Key Code Pattern
```javascript
// Instead of this (WRONG):
allFrames.push(...processedFrames);  // Accumulate
for frame of allFrames:
  encode(frame);

// Do this (CORRECT):
encodedFrameMap.set(frameIndex, imageData);
encodeBufferedFrames();  // Encode what's available
encodedFrameMap.delete(frameIndex);  // Release immediately
```
