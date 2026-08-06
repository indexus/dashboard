// Pure pass recorders. Each function takes a command encoder and a context
// object holding the GPU resources it needs. They never own state and never
// allocate anything outside the cached bind groups they request via
// `getOrCreate*BindGroup` callbacks.

const TRANSPARENT_CLEAR = { r: 0, g: 0, b: 0, a: 0 };

export function recordMaskPass(cmd, ctx) {
  const pass = cmd.beginRenderPass({
    colorAttachments: [
      {
        view: ctx.maskView,
        clearValue: TRANSPARENT_CLEAR,
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });

  if (ctx.indexCount > 0 && ctx.vertexBuffer && ctx.indexBuffer) {
    pass.setPipeline(ctx.pipeline);
    pass.setBindGroup(0, ctx.bindGroup);
    pass.setVertexBuffer(0, ctx.vertexBuffer);
    pass.setIndexBuffer(ctx.indexBuffer, "uint16");
    pass.drawIndexed(ctx.indexCount);
  }

  pass.end();
}

export function recordAccumPass(cmd, ctx) {
  const pass = cmd.beginRenderPass({
    colorAttachments: [
      {
        view: ctx.accumView,
        clearValue: TRANSPARENT_CLEAR,
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });

  if (ctx.instanceCount > 0 && ctx.instanceBuffer) {
    pass.setPipeline(ctx.pipeline);
    pass.setBindGroup(0, ctx.bindGroup);
    pass.setVertexBuffer(0, ctx.unitSquareBuffer);
    pass.setVertexBuffer(1, ctx.instanceBuffer);
    pass.draw(6, ctx.instanceCount, 0, 0);
  }

  pass.end();
}

// Returns false if the canvas surface is lost / unavailable; the caller
// should skip the frame and let the next one reacquire.
export function recordNormalizePass(cmd, ctx) {
  let canvasView;
  try {
    canvasView = ctx.context.getCurrentTexture().createView();
  } catch (e) {
    return false;
  }

  const pass = cmd.beginRenderPass({
    colorAttachments: [
      {
        view: canvasView,
        clearValue: TRANSPARENT_CLEAR,
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });

  pass.setPipeline(ctx.pipeline);
  pass.setBindGroup(0, ctx.bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();

  return true;
}
