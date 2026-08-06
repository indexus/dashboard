// WebGL compositor: draws the WebGPU OffscreenCanvas into MapLibre's WebGL
// framebuffer at the layer's compositing slot. This is what keeps the
// heatmap inserted *below* the labels / water / borders even though the
// pixels were produced by a different graphics API.
//
// We require WebGL2 (MapLibre v5+ defaults to it) so the upload is always a
// direct OffscreenCanvas → texImage2D call. No bitmap fallback, no Canvas2D
// readback path.
//
// The compositor owns a persistent GL texture, which lets the layer skip the
// upload entirely on idle frames (matrix + data unchanged) and re-blit the
// cached texture for almost-free repaint.

const COMPOSITE_VS = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = (a_position + 1.0) * 0.5;
}
`;

const COMPOSITE_FS = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

// Fullscreen triangle covering NDC [-1,-1] → [1,1].
const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

export class WebGLCompositor {
  constructor(gl) {
    this.gl = gl;
    this.program = null;
    this.posLoc = -1;
    this.texLoc = null;
    this.quadBuffer = null;
    this.texture = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.hasUpload = false;
  }

  init() {
    const gl = this.gl;
    if (!gl) return false;

    const program = compileProgram(gl, COMPOSITE_VS, COMPOSITE_FS);
    if (!program) return false;

    this.program = program;
    this.posLoc = gl.getAttribLocation(program, "a_position");
    this.texLoc = gl.getUniformLocation(program, "u_tex");

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    return true;
  }

  // Force full `texImage2D` on the next upload after a canvas resize.
  // Do **not** clear `hasUpload`: during zoom the map canvas size often
  // changes while the worker briefly emits empty packs; `hasValidComposite`
  // must stay true so `AverageGridLayerWebGPU` can re-blit the last good
  // texture (stretched) instead of running the accum pass with 0 instances
  // (`loadOp: clear` → blank until the next non-empty pack).
  invalidateTextureSize() {
    this.textureWidth = 0;
    this.textureHeight = 0;
  }

  // Whether `blit()` would draw something. Used by the layer to decide
  // whether it can preserve the on-screen heatmap during a transient
  // empty-pack frame (fast zoom + LOD streaming) instead of running the
  // full pipeline, which would clear the accum target and blank the layer.
  hasValidComposite() {
    return this.hasUpload && !!this.texture;
  }

  // Upload the current OffscreenCanvas pixels into the persistent GL texture.
  // Call this only when the WebGPU pipeline produced a new frame.
  upload(offscreen, width, height) {
    const gl = this.gl;
    if (!this.texture || !offscreen) return false;

    // WebGPU canvases use top-left origin. Flip to match the standard
    // "(a_position+1)*0.5" UV mapping in the composite vertex shader.
    // The source carries premultiplied alpha (alphaMode: "premultiplied"),
    // so do not premultiply again.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    if (width !== this.textureWidth || height !== this.textureHeight) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        offscreen
      );
      this.textureWidth = width;
      this.textureHeight = height;
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        offscreen
      );
    }

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.hasUpload = true;
    return true;
  }

  // Draw the persistent texture as a fullscreen quad into the current
  // framebuffer. Cheap enough to call every MapLibre frame.
  blit() {
    const gl = this.gl;
    if (!this.program || !this.texture || !this.hasUpload) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.posLoc);
    gl.vertexAttribPointer(this.posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.texLoc, 0);

    // Premultiplied alpha-over: result = src + dst * (1 - srcAlpha).
    // Our normalize pass writes premultiplied pixels into the OffscreenCanvas.
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // MapLibre always wants depth-test for its other layers; flip it off
    // for our fullscreen quad and back on without querying GL state (sync
    // reads stall the driver).
    gl.disable(gl.DEPTH_TEST);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // MapLibre expects array bindings not to leak between custom layers.
    gl.disableVertexAttribArray(this.posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.texture) gl.deleteTexture(this.texture);
    this.program = null;
    this.quadBuffer = null;
    this.texture = null;
    this.gl = null;
  }
}

function compileProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(
      "[WebGLCompositor] program link error:",
      gl.getProgramInfoLog(program)
    );
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      "[WebGLCompositor] shader compile error:",
      gl.getShaderInfoLog(shader)
    );
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
