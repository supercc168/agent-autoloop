// The process is a durable observer of one local project request. Its exit is not proof the Agent has stopped.
import { fileURLToPath } from "node:url";
import type { Adapter, Reading } from "../../worker/agents.ts";
import { prepareTurn, observeTurn } from "./run.ts";

export default {
  resumePolicy: "strict",
  command(turn) {
    const file = prepareTurn(turn);
    return [process.execPath, fileURLToPath(new URL("./run.ts", import.meta.url)), "--turn", file];
  },
  read(stdout, code, stderr) {
    for (const line of stdout.trim().split("\n").reverse()) {
      try {
        const packet = JSON.parse(line);
        if (packet?.protocol === "lodestar-adapter-v1" && packet.reading && typeof packet.reading === "object") {
          return packet.reading as Reading;
        }
      } catch {}
    }
    return code === null ? {} : { pending: true, diagnostic: stderr.trim() || "本机观察进程已退出，正在核对实际任务" };
  },
  reconcile: (turn) => observeTurn(turn),
  cancel: (turn) => observeTurn(turn, true),
  check() {
    // Configuration and credentials are validated for the selected project at launch, never guessed from a global CLI.
    return null;
  },
} satisfies Adapter;
