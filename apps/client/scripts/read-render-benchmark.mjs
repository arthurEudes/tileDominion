import WebSocket from "ws";

const deadline = Date.now() + 60_000;
let pages;
while (Date.now() < deadline) {
  try {
    pages = await fetch("http://127.0.0.1:9223/json").then((response) =>
      response.json(),
    );
    if (pages.some((page) => page.url.includes("benchmark.html"))) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const page = pages?.find((candidate) => candidate.url.includes("benchmark.html"));
if (!page) throw new Error("Page de benchmark Chromium introuvable");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result.result.value);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
}
while (Date.now() < deadline) {
  if ((await evaluate("document.title")) === "BENCHMARK_DONE") {
    console.log(await evaluate("document.querySelector('#results').textContent"));
    socket.close();
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error(await evaluate("document.querySelector('#results')?.textContent"));
socket.close();
throw new Error("Le benchmark Phaser a dépassé 60 secondes");
