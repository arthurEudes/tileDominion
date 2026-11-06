const COLS = 40;
const ROWS = 24;
const FPS = 30;
const COLORS = ["#37d9c4", "#e65264", "#f2bd3f", "#607ee8"];

type Unit = { x: number; y: number; angle: number; team: number; phase: number };

export class MenuBattle {
  private readonly context: CanvasRenderingContext2D;
  private readonly tiles = new Uint8Array(COLS * ROWS);
  private readonly units: Unit[] = [];
  private frame = 0;
  private lastFrame = 0;
  private running = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D indisponible");
    this.context = context;
    this.canvas.width = 600;
    this.canvas.height = 360;
    this.seed();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.draw(0);
      return;
    }
    this.start();
  }

  start() {
    if (this.running && this.frame) return;
    this.running = true;
    this.lastFrame = 0;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private seed() {
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const team = x < COLS / 2 ? (y < ROWS / 2 ? 0 : 3) : (y < ROWS / 2 ? 1 : 2);
        this.tiles[y * COLS + x] = team;
      }
    }
    for (let team = 0; team < COLORS.length; team++) {
      const originX = team === 0 || team === 3 ? .18 : .82;
      const originY = team < 2 ? .2 : .8;
      for (let i = 0; i < 8; i++) {
        this.units.push({
          x: originX + ((i % 4) - 1.5) * .025,
          y: originY + (Math.floor(i / 4) - .5) * .035,
          angle: team * Math.PI / 2,
          team,
          phase: i * .79 + team * 1.31,
        });
      }
    }
  }

  private readonly onVisibilityChange = () => {
    if (!document.hidden && this.running) {
      this.lastFrame = 0;
      this.frame = requestAnimationFrame(this.tick);
    }
  };

  private readonly tick = (now: number) => {
    if (!this.running || document.hidden) return;
    if (now - this.lastFrame >= 1000 / FPS) {
      const elapsed = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, .15) : 0;
      this.lastFrame = now;
      this.update(elapsed, now / 1000);
      this.draw(now / 1000);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private update(elapsed: number, time: number) {
    for (const unit of this.units) {
      const targetX = .5 + Math.sin(time * .19 + unit.phase) * .2;
      const targetY = .5 + Math.cos(time * .16 + unit.phase * 1.7) * .2;
      const desired = Math.atan2(targetY - unit.y, targetX - unit.x);
      unit.angle += Math.atan2(Math.sin(desired - unit.angle), Math.cos(desired - unit.angle)) * .08;
      unit.x = Math.max(.02, Math.min(.98, unit.x + Math.cos(unit.angle) * elapsed * .055));
      unit.y = Math.max(.03, Math.min(.97, unit.y + Math.sin(unit.angle) * elapsed * .055));
      const tx = Math.min(COLS - 1, Math.floor(unit.x * COLS));
      const ty = Math.min(ROWS - 1, Math.floor(unit.y * ROWS));
      this.tiles[ty * COLS + tx] = unit.team;
    }
  }

  private draw(time: number) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const tileWidth = width / COLS;
    const tileHeight = height / ROWS;
    this.context.fillStyle = "#07111f";
    this.context.fillRect(0, 0, width, height);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        this.context.globalAlpha = .27;
        this.context.fillStyle = COLORS[this.tiles[y * COLS + x]];
        this.context.fillRect(x * tileWidth + 1, y * tileHeight + 1, tileWidth - 1, tileHeight - 1);
      }
    }
    this.context.globalAlpha = 1;
    for (const unit of this.units) {
      const x = unit.x * width;
      const y = unit.y * height;
      const pulse = 1 + Math.sin(time * 3 + unit.phase) * .12;
      this.context.fillStyle = COLORS[unit.team];
      this.context.beginPath();
      this.context.arc(x, y, 4.5 * pulse, 0, Math.PI * 2);
      this.context.fill();
      this.context.strokeStyle = "#eaf2ff";
      this.context.lineWidth = 1.5;
      this.context.stroke();
      this.context.strokeStyle = COLORS[unit.team];
      this.context.globalAlpha = .35;
      this.context.beginPath();
      this.context.moveTo(x, y);
      this.context.lineTo(x - Math.cos(unit.angle) * 14, y - Math.sin(unit.angle) * 14);
      this.context.stroke();
      this.context.globalAlpha = 1;
    }
  }
}
