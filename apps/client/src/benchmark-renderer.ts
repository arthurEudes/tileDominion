import Phaser from "phaser";

type Result = {
  units: number;
  averageFps: number;
  p95FrameMs: number;
  maxFrameMs: number;
  p95UpdateMs: number;
};

const counts = [1000, 2000, 4000, 8000, 16000, 32000],
  output = document.querySelector("#results") as HTMLElement,
  results: Result[] = [];

class RendererBenchmark extends Phaser.Scene {
  blitter?: Phaser.GameObjects.Blitter;
  overlay?: Phaser.GameObjects.Graphics;
  targets = new Map<number, { x: number; y: number }>();
  bobs = new Map<number, Phaser.GameObjects.Bob>();
  frames: number[] = [];
  updates: number[] = [];
  lastFrameAt = 0;
  stage = 0;
  stageStarted = 0;

  create() {
    const texture = this.textures.createCanvas("bench-unit", 12, 12);
    if (!texture) throw new Error("Impossible de créer la texture de benchmark");
    texture.context.fillStyle = "#ffffff";
    texture.context.fillRect(0, 0, 12, 12);
    texture.refresh();
    this.blitter = this.add.blitter(0, 0, "bench-unit");
    this.overlay = this.add.graphics().setDepth(1);
    this.startStage(0);
  }

  startStage(index: number) {
    const targetCount = counts[index];
    while (this.targets.size < targetCount) {
      const id = this.targets.size,
        x = (id * 17) % 1280,
        y = (Math.floor(id / 75) * 13) % 720;
      this.targets.set(id, { x, y });
      this.bobs.set(
        id,
        this.blitter!
          .create(x - 6, y - 6)
          .setTint(id % 2 ? 0x48dbfb : 0xff6b6b),
      );
    }
    this.frames = [];
    this.updates = [];
    this.lastFrameAt = performance.now();
    this.stageStarted = performance.now();
    output.textContent = `Benchmark Phaser WebGL : ${targetCount} unités…`;
  }

  update(_time: number, delta: number) {
    const frameStarted = performance.now(),
      frameInterval = frameStarted - this.lastFrameAt,
      elapsed = frameStarted - this.stageStarted;
    this.lastFrameAt = frameStarted;
    this.overlay!.clear();
    for (const [id, bob] of this.bobs) {
      const target = this.targets.get(id)!;
      bob.x = Phaser.Math.Linear(bob.x, target.x - 6, 0.5);
      bob.y = Phaser.Math.Linear(bob.y, target.y - 6, 0.5);
      bob.setVisible(true);
      if (id % 8 === 0)
        this.overlay!
          .fillStyle(0x160c16, 0.9)
          .fillRect(target.x - 7, target.y - 10, 14, 2)
          .fillStyle(0x43e38f, 1)
          .fillRect(target.x - 7, target.y - 10, 9, 2);
    }
    if (elapsed >= 1000) {
      this.frames.push(frameInterval);
      this.updates.push(performance.now() - frameStarted);
    }
    if (elapsed < 4000) return;

    const sorted = [...this.frames].sort((a, b) => a - b),
      sortedUpdates = [...this.updates].sort((a, b) => a - b),
      total = this.frames.reduce((sum, value) => sum + value, 0),
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    results.push({
      units: counts[this.stage],
      averageFps: (this.frames.length * 1000) / total,
      p95FrameMs: p95,
      maxFrameMs: Math.max(...this.frames),
      p95UpdateMs:
        sortedUpdates[
          Math.min(
            sortedUpdates.length - 1,
            Math.floor(sortedUpdates.length * 0.95),
          )
        ],
    });
    this.stage++;
    if (this.stage < counts.length) this.startStage(this.stage);
    else {
      output.textContent = JSON.stringify(results, null, 2);
      document.title = "BENCHMARK_DONE";
      this.scene.pause();
    }
  }
}

new Phaser.Game({
  type: Phaser.WEBGL,
  parent: "benchmark",
  width: 1280,
  height: 720,
  backgroundColor: "#08131f",
  scene: RendererBenchmark,
  banner: false,
  fps: { target: 120, forceSetTimeOut: false },
});
