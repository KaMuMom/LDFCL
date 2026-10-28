const { PassThrough } = require("node:stream");
const fs = require("node:fs/promises");
const path = require("node:path");

async function physicalPath(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await physicalPath(parent), path.basename(file));
  }
}

/** Capture the actual anonymous-pipe payload in a mocked process, then assert
 * game-level semantics independently of whether launch needs a Unicode bridge.
 */
function captureJavaStdin(child, invocation) {
  child.stdin = new PassThrough();
  const chunks = [];
  child.stdin.on("data", (chunk) => {
    chunks.push(chunk);
    invocation.input = Buffer.concat(chunks);
  });
}

function decodedJavaInvocation(invocation) {
  if (!invocation.input) {
    const offset = invocation.args.indexOf("-cp");
    return { args: invocation.args, classpath: invocation.args[offset + 1] };
  }
  const input = invocation.input;
  let offset = 0;
  const integer = () => { const value = input.readInt32BE(offset); offset += 4; return value; };
  const string = () => { const length = integer(); const value = input.subarray(offset, offset + length).toString("utf8"); offset += length; return value; };
  if (integer() !== 0x4c444631) throw Error("Invalid Java pipe protocol");
  const classpath = string();
  const mainClass = string();
  const properties = {};
  const count = integer();
  for (let index = 0; index < count; index++) properties[string()] = string();
  const argumentsCount = integer();
  const args = Array.from({ length: argumentsCount }, string);
  if (offset !== input.length) throw Error("Unexpected Java pipe payload bytes");
  return { args, classpath, mainClass, properties };
}

module.exports = { captureJavaStdin, decodedJavaInvocation, physicalPath };
