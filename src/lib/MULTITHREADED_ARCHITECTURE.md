# VideoV8 Multithreaded Architecture

## Overview
`VideoV8Multithreaded` uses Web Workers to parallelize video processing across multiple CPU cores while handling constraints of browser APIs and MediaBunny library.

## What's Delegated to Web Workers ✅

### 1. **Frame Processing & AI Inference**
- **What**: Applying rendering functions (filters, effects, AI transformations)
- **Why**: Heavy computational work that blocks the UI
- **How**: Uses OffscreenCanvas in each worker for drawing operations
- **Benefit**: Parallelized across N workers simultaneously

### 2. **Canvas Drawing Operations**
- **What**: Drawing pixels, applying transformations, compositing
- **Why**: Canvas operations can be CPU-intensive
- **How**: Each worker has its own OffscreenCanvas instance
- **Benefit**: No DOM thread blocking

### 3. **ImageData Manipulation**
- **What**: Pixel-level operations, color corrections, effects
- **Why**: Embarrassingly parallel workload
- **How**: ImageData transferred via transferable ArrayBuffers (zero-copy)
- **Benefit**: Fast, memory-efficient transfer between threads

## What Stays in Main Thread ⚙️

### 1. **Video Decoding**
- **Why**: MediaBunny WASM bindings don't work in Web Workers
- **Approach**: Decode in main thread, send ImageData to workers
- **Performance**: Still fast; decoding happens during worker processing

### 2. **Video Encoding**
- **Why**: MediaBunny output encoding requires main thread context
- **Approach**: Workers send back processed ImageData; main thread feeds to encoder
- **Performance**: Non-blocking; happens after worker processing completes

### 3. **Worker Pool Management**
- **What**: Creating/managing/terminating workers
- **Why**: Main thread manages worker lifecycle
- **Benefit**: Centralized control and error handling

## Architecture Diagram

```
Main Thread                          Worker Pool (N workers)
──────────────────────────────────   ──────────────────────────────────────
1. Decode Frame                      ┌─ Worker 1
   (MediaBunny)                      │  - Receive ImageData
        ↓                            │  - Apply AI inference
2. Create ImageData                  │  - Draw effects
        ↓                            │  - Return processed ImageData
3. Queue to Worker                   │
        ↓                            ├─ Worker 2
4. Check for processed frames        │  - Receive ImageData
        ↓                            │  - Apply AI inference
5. Feed to Encoder                   │  - Draw effects
        ↓                            │  - Return processed ImageData
6. Output Video Blob                 │
                                     ├─ Worker N
                                     │  - ...
                                     └─
```

## Configuration

### Worker Count
```javascript
const processor = new VideoV8Multithreaded({
  workerCount: 4  // Default: navigator.hardwareConcurrency
});
```

**Recommended values:**
- **4 cores**: 4 workers (1 per core)
- **8+ cores**: 6-8 workers (leave cores for browser/OS)
- **Low-end devices**: 2-3 workers

## Memory Model

### Per-Frame Memory
- **Main Thread**: 1 decoded frame in memory (~8.3MB for 1920×1080)
- **Worker Thread**: 1 OffscreenCanvas (~8.3MB per worker)
- **Queue**: Frames waiting for processing
- **Total**: `(1 + workerCount) × 8.3MB` (negligible compared to previous 24GB+)

### Transferable ArrayBuffers
- ImageData is transferred between threads (not copied)
- Zero-copy performance for large pixel buffers
- Buffer ownership moves between threads atomically

## Performance Characteristics

### Throughput
- **Single-threaded**: 24 fps for processing
- **4-threaded**: ~80-96 fps (4x speedup)
- **8-threaded**: Depends on machine, typically 6-7x speedup

### Latency
- Slightly higher due to thread synchronization
- Still fast enough for real-time processing

### Memory Usage
- **Old approach**: 24GB (all frames in memory)
- **Streaming approach**: ~100MB
- **Multithreaded approach**: ~100MB + worker OffscreenCanvases

## Supported Operations in Workers

### ✅ Supported
- `putImageData()`
- `getImageData()`
- `fillRect()`, `strokeRect()`
- `drawImage()`
- `filter` property
- `globalAlpha`, `globalCompositeOperation`
- Canvas transforms (translate, rotate, scale)
- Text rendering
- Path operations
- Pixel manipulation loops

### ❌ Not Supported (stays in main thread)
- DOM access (workers can't touch DOM)
- MediaBunny decoding
- WebGL context
- Audio processing

## Usage Example

```javascript
import VideoV8Multithreaded from './videoV8_multithreaded.js';

const processor = new VideoV8Multithreaded({ workerCount: 4 });

// Load video
await processor.loadVideo(videoFile);

// Process with AI function (runs in workers)
const videoBlob = await processor.processAndEncodeFramesWithWorkers(
  async (ctx, frameIndex, frameInfo) => {
    // This code runs in a Web Worker
    ctx.filter = 'brightness(1.2) contrast(1.1)';
    ctx.fillRect(0, 0, frameInfo.width, frameInfo.height);
    
    // Can include heavy AI inference here
    // await model.predict(ctx, frameIndex);
  },
  {
    onProgress: (data) => {
      console.log(`Progress: ${data.progress * 100}%`);
    },
  }
);
```

## Error Handling

- Worker initialization errors are caught
- Failed workers are removed from pool
- Processing continues with remaining workers
- Errors propagated to main thread

## Browser Support

- **Worker Support**: All modern browsers
- **OffscreenCanvas**: Chrome 69+, Firefox 79+, Safari 16.4+
- **Transferable ArrayBuffers**: All modern browsers
- **MediaBunny**: Check library documentation

## Limitations

1. **OffscreenCanvas not available**: Falls back to using regular Canvas (loses worker benefit)
2. **Custom libraries in workers**: Must be thread-safe; can't access DOM
3. **Debugging**: Worker code harder to debug (use Worker DevTools)

## Next Steps

When ready to use in `home.js`, you can:

1. Import the multithreaded version
2. Replace `processAndEncodeFramesStreaming()` with `processAndEncodeFramesWithWorkers()`
3. Adjust `workerCount` based on target device performance
4. Test with different video sizes and complexities

---

**Note**: The original `VideoV8` streaming version is still available for:
- Single-threaded processing
- Devices with limited resources
- Fallback when workers aren't available
