// Live checks with real agents (via Ori):
//   * an image sent to the first agent is carried to the next ones as a real
//     image block (each must name its colour)
//   * session/cancel stops a running turn on each agent, and the conversation
//     continues afterwards
//   * pi-acp's update banner stays out of the transcript
//   node test/live-extras.ts [agent ...]       (default: claude codex pi)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PortableSession } from "../src/portable.ts";
import { TerminalHost } from "../src/terminal-host.ts";

const agents = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex", "pi"];
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${what}`);
  if (!ok) failures++;
};

/** A solid-colour PNG, built by hand so the test needs no image tooling. */
function png(w: number, h: number, [r, g, b]: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); t.copy(out, 4); out.writeUInt32BE(crc(t), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

let text = "";
const s = PortableSession.create(mkdtempSync(join(tmpdir(), "acpp-live-")), {}, new TerminalHost({ yolo: true, out: () => {} }));
s.onUpdate = (u) => { if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text; };

for (const [i, agent] of agents.entries()) {
  await s.attach(agent);
  text = "";
  if (i === 0) {
    await s.prompt([{ type: "text", text: "What colour is this image? Answer with one word." }, { type: "image", mimeType: "image/png", data: png(64, 64, [220, 20, 20]) }]);
  } else {
    await s.prompt("Earlier in this conversation I sent an image. What colour was it? Answer with one word, without using tools.");
  }
  check(/red/i.test(text), `${agent}: names the image's colour (${text.trim().slice(0, 40)})`);

  text = "";
  const turn = s.prompt("Write the numbers from 1 to 3000, one per line, as plain text. Do not use any tools.");
  await new Promise((r) => setTimeout(r, 4000));
  await s.cancel();
  const res = await turn;
  check(res.stopReason === "cancelled", `${agent}: session/cancel → stopReason=${res.stopReason} (${text.length} chars streamed)`);

  text = "";
  await s.prompt("Reply with exactly: STILL-HERE");
  check(text.includes("STILL-HERE"), `${agent}: conversation continues after cancel${text.includes("STILL-HERE") ? "" : ` (got ${JSON.stringify(text.slice(0, 160))})`}`);
}

const banner = s.conv.entries.some((e) => e.t === "assistant" && e.text.includes("New version available"));
check(!banner, "no adapter update banner in the transcript");
s.dispose();
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
