// A push-optimal Sokoban solver, written for make.fun's sokoban-solver-01 bounty.
//
// How the generated levels are shaped (see the kit's RULES.txt): a one-wide hallway
// runs across the board with the player in it, and one to four rooms open off it,
// each through a single door, holding three or four boxes and as many goals. A box
// pushed through a door into the hallway can never be pushed back, so every box
// stays in its room and a level's push-optimal count is the sum of its rooms'
// optima. This solver leans on that: it solves each room on its own,
// push-optimally, and stitches the rooms together with shortest player walks.
//
// Each room is solved with an A* search over pushes. A state is the room's boxes
// plus the region the player can reach (walks between pushes are free, so the exact
// player square does not matter, only which region it stands in). The search is
// guided by the cheapest assignment of boxes to goals by shortest-path distance,
// and prunes positions no push can save: dead squares (found by pulling boxes back
// from the goals), corner deadlocks, 2x2 blocks of boxes and walls, and boxes stuck
// against a wall segment that holds no goal. The search budget is a fixed number
// of node expansions, never the clock, so two runs always give the same answer.
// If the optimal search runs out of budget, a weighted search and then a greedy
// search try for any solution instead; a room left unsolved leaves the level
// unanswered rather than guessed at.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four steps: up, down, left, right. Direction d's opposite is d ^ 1. */
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

/** Expansion budgets. The optimal search first; the others only on a miss. */
const CAP_OPTIMAL = 250_000;
const CAP_WEIGHTED = 250_000;
const CAP_GREEDY = 250_000;

/** The neighbour of cell c in direction d, or -1 when it leaves the board. */
function stepOf(w: number, h: number, c: number, d: number): number {
  const x = c % w;
  const y = (c / w) | 0;
  const dir = DIRS[d]!;
  const nx = x + dir.dx;
  const ny = y + dir.dy;
  if (nx < 0 || nx >= w || ny < 0 || ny >= h) return -1;
  return ny * w + nx;
}

interface Push {
  from: number;
  to: number;
  dir: number;
}

interface Room {
  cells: number[];
  boxes: number[];
  goals: number[];
  door: number;
  entry: number;
}

class Level {
  w: number;
  h: number;
  n: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
  /** Generation stamps for flood fills and searches. */
  stamp: Int32Array;
  stampGen = 0;
  regionMark: Int32Array;
  regionGen = 0;
  blocked: Uint8Array;
  walkParent: Int32Array;
  walkDir: Int8Array;

  constructor(text: string) {
    const rows = text.split('\n').filter((r) => r.length > 0);
    const w = Math.max(...rows.map((r) => r.length));
    const h = rows.length;
    const n = w * h;
    const wall = new Uint8Array(n).fill(1);
    const goal = new Uint8Array(n);
    const boxes: number[] = [];
    let player = 0;
    rows.forEach((row, y) => {
      for (let x = 0; x < w; x++) {
        const ch = row[x] ?? '#';
        const i = y * w + x;
        if (ch === '#') continue;
        wall[i] = 0;
        if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
        if (ch === '$' || ch === '*') boxes.push(i);
        if (ch === '@' || ch === '+') player = i;
      }
    });
    boxes.sort((a, b) => a - b);
    this.w = w;
    this.h = h;
    this.n = n;
    this.wall = wall;
    this.goal = goal;
    this.boxes = boxes;
    this.player = player;
    this.stamp = new Int32Array(n);
    this.regionMark = new Int32Array(n);
    this.blocked = new Uint8Array(n);
    this.walkParent = new Int32Array(n);
    this.walkDir = new Int8Array(n);
  }

  isWall(c: number): boolean {
    return c < 0 || c >= this.n || this.wall[c] === 1;
  }

  /**
   * Flood fill from `start` over `walkable` cells that hold no box, stamping the
   * reached cells with generation `gen` in `mark`. Returns the smallest reached
   * cell, which names the region: the region is the connected component holding
   * that cell, so the minimum identifies it.
   */
  floodRun(start: number, boxes: number[], walkable: Uint8Array, mark: Int32Array, gen: number): number {
    for (const b of boxes) this.blocked[b] = 1;
    const stack: number[] = [start];
    mark[start] = gen;
    let min = start;
    const { w, h } = this;
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (c < min) min = c;
      const x = c % w;
      const y = (c / w) | 0;
      if (y > 0) {
        const nb = c - w;
        if (walkable[nb] === 1 && this.blocked[nb] === 0 && mark[nb] !== gen) {
          mark[nb] = gen;
          stack.push(nb);
        }
      }
      if (y < h - 1) {
        const nb = c + w;
        if (walkable[nb] === 1 && this.blocked[nb] === 0 && mark[nb] !== gen) {
          mark[nb] = gen;
          stack.push(nb);
        }
      }
      if (x > 0) {
        const nb = c - 1;
        if (walkable[nb] === 1 && this.blocked[nb] === 0 && mark[nb] !== gen) {
          mark[nb] = gen;
          stack.push(nb);
        }
      }
      if (x < w - 1) {
        const nb = c + 1;
        if (walkable[nb] === 1 && this.blocked[nb] === 0 && mark[nb] !== gen) {
          mark[nb] = gen;
          stack.push(nb);
        }
      }
    }
    for (const b of boxes) this.blocked[b] = 0;
    return min;
  }

  /** Shortest player walk from `from` to `to` over open floor, avoiding boxes. */
  walkPath(from: number, to: number, boxes: number[]): string | null {
    if (from === to) return '';
    for (const b of boxes) this.blocked[b] = 1;
    const gen = ++this.stampGen;
    const { w, h, stamp, walkParent, walkDir } = this;
    const queue: number[] = [from];
    stamp[from] = gen;
    walkParent[from] = -1;
    let head = 0;
    let found = false;
    while (head < queue.length) {
      const c = queue[head++]!;
      if (c === to) {
        found = true;
        break;
      }
      const x = c % w;
      const y = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        let nb = -1;
        if (d === 0 && y > 0) nb = c - w;
        else if (d === 1 && y < h - 1) nb = c + w;
        else if (d === 2 && x > 0) nb = c - 1;
        else if (d === 3 && x < w - 1) nb = c + 1;
        if (nb < 0 || this.wall[nb] === 1 || this.blocked[nb] === 1 || stamp[nb] === gen) continue;
        stamp[nb] = gen;
        walkParent[nb] = c;
        walkDir[nb] = d;
        queue.push(nb);
      }
    }
    for (const b of boxes) this.blocked[b] = 0;
    if (!found) return null;
    let moves = '';
    for (let c = to; walkParent[c]! >= 0; c = walkParent[c]!) {
      moves = DIRS[walkDir[c]!]!.ch + moves;
    }
    return moves;
  }

  /**
   * Solve one room push-optimally. Boxes may only be pushed onto the room's own
   * cells; the player may also walk the hallway, which is what lets it push a
   * box sitting in the doorway back inside. Returns the pushes, or null.
   */
  solveRoom(room: Room, hallway: Uint8Array, startPlayer: number): Push[] | null {
    const { w, h, n, wall, goal } = this;
    const cells = room.cells;
    const m = cells.length;
    const roomSet = new Uint8Array(n);
    const roomIdx = new Int32Array(n).fill(-1);
    cells.forEach((c, i) => {
      roomSet[c] = 1;
      roomIdx[c] = i;
    });
    const walkable = new Uint8Array(n);
    for (const c of cells) walkable[c] = 1;
    for (let c = 0; c < n; c++) if (hallway[c] === 1) walkable[c] = 1;
    const goals = room.goals;
    const goalIdx = goals.map((c) => roomIdx[c]!);

    // Shortest-path distances between room cells, ignoring boxes. A box's true
    // push distance to a goal is never shorter than this.
    const INF = 1e9;
    const dist = new Int32Array(m * m).fill(INF);
    for (let i = 0; i < m; i++) {
      const src = cells[i]!;
      const gen = ++this.stampGen;
      const queue: number[] = [src];
      this.stamp[src] = gen;
      dist[i * m + i] = 0;
      let head = 0;
      while (head < queue.length) {
        const c = queue[head++]!;
        for (let d = 0; d < 4; d++) {
          const nb = stepOf(w, h, c, d);
          if (nb < 0 || roomSet[nb] === 0 || this.stamp[nb] === gen) continue;
          this.stamp[nb] = gen;
          dist[i * m + roomIdx[nb]!] = dist[i * m + roomIdx[c]!]! + 1;
          queue.push(nb);
        }
      }
    }

    // Dead squares: pull boxes back from the goals, ignoring other boxes. A box
    // on a square no pull can reach can never be pushed onto a goal.
    const live = new Uint8Array(n);
    const pullQueue: number[] = [];
    for (const g of goals) {
      live[g] = 1;
      pullQueue.push(g);
    }
    while (pullQueue.length > 0) {
      const c = pullQueue.pop()!;
      for (let d = 0; d < 4; d++) {
        const nb = stepOf(w, h, c, d);
        if (nb < 0 || roomSet[nb] === 0 || live[nb] === 1) continue;
        // Pushing a box from nb to c needs the player on nb's far side.
        const stand = stepOf(w, h, nb, d ^ 1);
        if (stand < 0 || wall[stand] === 1) continue;
        live[nb] = 1;
        pullQueue.push(nb);
      }
    }

    const filled = (c: number, bs: number[]): boolean =>
      c < 0 || c >= n || wall[c] === 1 || bs.indexOf(c) >= 0;

    /** True when some box sits where no push can ever save it. */
    const isDead = (bs: number[]): boolean => {
      for (const b of bs) {
        if (goal[b] === 1) continue;
        if (live[b] === 0) return true;
        const x = b % w;
        const y = (b / w) | 0;
        const up = y > 0 ? b - w : -1;
        const dn = y < h - 1 ? b + w : -1;
        const lf = x > 0 ? b - 1 : -1;
        const rt = x < w - 1 ? b + 1 : -1;
        const wUp = up < 0 || wall[up] === 1;
        const wDn = dn < 0 || wall[dn] === 1;
        const wLf = lf < 0 || wall[lf] === 1;
        const wRt = rt < 0 || wall[rt] === 1;
        if ((wUp && wLf) || (wUp && wRt) || (wDn && wLf) || (wDn && wRt)) return true;
        // A 2x2 block of walls and boxes: no box inside it can ever be pushed,
        // because every push needs a free square or a free stance inside it.
        for (const hs of [-1, 1]) {
          for (const vs of [-1, 1]) {
            const c1 = x + hs >= 0 && x + hs < w ? b + hs : -1;
            const c2 = y + vs >= 0 && y + vs < h ? b + vs * w : -1;
            const c3 = c1 >= 0 && c2 >= 0 ? b + hs + vs * w : -1;
            if (filled(c1, bs) && filled(c2, bs) && filled(c3, bs)) return true;
          }
        }
        // Against a wall, a box can only slide along it. When the whole stretch
        // of wall it can slide on holds no goal and is walled at both ends, the
        // box can never reach a goal.
        for (let s = 0; s < 4; s++) {
          const side = stepOf(w, h, b, s);
          if (side < 0 || wall[side] === 0) continue;
          const perpA = s < 2 ? 2 : 0;
          const perpB = s < 2 ? 3 : 1;
          const run: number[] = [b];
          let endA = false;
          let endB = false;
          let cur = b;
          for (;;) {
            const nxt = stepOf(w, h, cur, perpA);
            if (nxt < 0 || wall[nxt] === 1) {
              endA = true;
              break;
            }
            const beyond = stepOf(w, h, nxt, s);
            if (beyond < 0 || wall[beyond] === 0) break;
            run.push(nxt);
            cur = nxt;
          }
          cur = b;
          for (;;) {
            const nxt = stepOf(w, h, cur, perpB);
            if (nxt < 0 || wall[nxt] === 1) {
              endB = true;
              break;
            }
            const beyond = stepOf(w, h, nxt, s);
            if (beyond < 0 || wall[beyond] === 0) break;
            run.push(nxt);
            cur = nxt;
          }
          if (endA && endB && !run.some((c) => goal[c] === 1)) return true;
        }
      }
      return false;
    };

    // Cheapest assignment of boxes to goals by shortest-path distance, by exact
    // permutation (at most four boxes). Admissible: one push moves one box one
    // square, so no solution costs less than this.
    const hCache = new Map<string, number>();
    const heuristic = (bs: number[]): number => {
      const key = bs.join(',');
      const hit = hCache.get(key);
      if (hit !== undefined) return hit;
      const bi = bs.map((c) => roomIdx[c]!);
      const k = bi.length;
      let best = INF;
      const used = new Uint8Array(k);
      const rec = (i: number, sum: number): void => {
        if (sum >= best) return;
        if (i === k) {
          best = sum;
          return;
        }
        for (let j = 0; j < k; j++) {
          if (used[j] === 1) continue;
          const d = dist[bi[i]! * m + goalIdx[j]!]!;
          if (d >= INF) continue;
          used[j] = 1;
          rec(i + 1, sum + d);
          used[j] = 0;
        }
      };
      rec(0, 0);
      const val = best >= INF ? 1e6 : best;
      hCache.set(key, val);
      return val;
    };

    const solved = (bs: number[]): boolean => bs.every((c) => goal[c] === 1);

    const search = (cap: number, gw: number, hw: number): Push[] | null => {
      const nBoxes: number[][] = [];
      const nPlayer: number[] = [];
      const nMin: number[] = [];
      const nG: number[] = [];
      const nF: number[] = [];
      const nParent: number[] = [];
      const nFrom: number[] = [];
      const nTo: number[] = [];
      const nDir: number[] = [];
      const best = new Map<string, number>();
      const heap: number[] = [];
      const less = (a: number, b: number): boolean => {
        if (nF[a] !== nF[b]) return nF[a]! < nF[b]!;
        if (nG[a] !== nG[b]) return nG[a]! > nG[b]!;
        return a < b;
      };
      const heapPush = (id: number): void => {
        heap.push(id);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (!less(heap[i]!, heap[p]!)) break;
          const t = heap[i]!;
          heap[i] = heap[p]!;
          heap[p] = t;
          i = p;
        }
      };
      const heapPop = (): number => {
        const top = heap[0]!;
        const last = heap.pop()!;
        if (heap.length > 0) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            let c = 2 * i + 1;
            if (c >= heap.length) break;
            if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
            if (!less(heap[c]!, heap[i]!)) break;
            const t = heap[i]!;
            heap[i] = heap[c]!;
            heap[c] = t;
            i = c;
          }
        }
        return top;
      };

      const startBoxes = [...room.boxes].sort((a, b) => a - b);
      const startMin = this.floodRun(startPlayer, startBoxes, walkable, this.stamp, ++this.stampGen);
      const key0 = startBoxes.join(',') + '#' + startMin;
      best.set(key0, 0);
      nBoxes.push(startBoxes);
      nPlayer.push(startPlayer);
      nMin.push(startMin);
      nG.push(0);
      nF.push(heuristic(startBoxes) * hw);
      nParent.push(-1);
      nFrom.push(-1);
      nTo.push(-1);
      nDir.push(-1);
      heapPush(0);

      let expansions = 0;
      while (heap.length > 0) {
        const id = heapPop();
        const bs = nBoxes[id]!;
        const key = bs.join(',') + '#' + nMin[id];
        if (best.get(key) !== nG[id]) continue;
        if (solved(bs)) {
          const pushes: Push[] = [];
          for (let t = id; nParent[t]! >= 0; t = nParent[t]!) {
            pushes.push({ from: nFrom[t]!, to: nTo[t]!, dir: nDir[t]! });
          }
          pushes.reverse();
          return pushes;
        }
        if (++expansions > cap) return null;
        const gen = ++this.regionGen;
        this.floodRun(nPlayer[id]!, bs, walkable, this.regionMark, gen);
        for (let bi = 0; bi < bs.length; bi++) {
          const b = bs[bi]!;
          for (let d = 0; d < 4; d++) {
            const to = stepOf(w, h, b, d);
            if (to < 0 || roomSet[to] === 0) continue;
            if (bs.indexOf(to) >= 0) continue;
            const pushPos = stepOf(w, h, b, d ^ 1);
            if (pushPos < 0 || this.regionMark[pushPos] !== gen) continue;
            const nb = bs.slice();
            nb[bi] = to;
            nb.sort((x, y) => x - y);
            if (isDead(nb)) continue;
            const g2 = nG[id]! + 1;
            const min2 = this.floodRun(b, nb, walkable, this.stamp, ++this.stampGen);
            const key2 = nb.join(',') + '#' + min2;
            const prev = best.get(key2);
            if (prev !== undefined && prev <= g2) continue;
            best.set(key2, g2);
            const nid = nBoxes.length;
            nBoxes.push(nb);
            nPlayer.push(b);
            nMin.push(min2);
            nG.push(g2);
            nF.push(g2 * gw + heuristic(nb) * hw);
            nParent.push(id);
            nFrom.push(b);
            nTo.push(to);
            nDir.push(d);
            heapPush(nid);
          }
        }
      }
      return null;
    };

    return search(CAP_OPTIMAL, 1, 1) ?? search(CAP_WEIGHTED, 1, 3) ?? search(CAP_GREEDY, 0, 1);
  }

  /** Solve the whole level: rooms in turn, stitched with player walks. */
  solve(): string {
    const { w, h, n, wall } = this;
    const y0 = (this.player / w) | 0;
    const hallway = new Uint8Array(n);
    for (let x = 0; x < w; x++) {
      const c = y0 * w + x;
      if (wall[c] === 0) hallway[c] = 1;
    }

    // Rooms: connected floor off the hallway row.
    const compId = new Int32Array(n).fill(-1);
    const comps: number[][] = [];
    for (let c = 0; c < n; c++) {
      if (wall[c] === 1 || (c / w | 0) === y0 || compId[c] >= 0) continue;
      const comp: number[] = [];
      const stack: number[] = [c];
      compId[c] = comps.length;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (let d = 0; d < 4; d++) {
          const nb = stepOf(w, h, cur, d);
          if (nb < 0 || wall[nb] === 1 || (nb / w | 0) === y0 || compId[nb] >= 0) continue;
          compId[nb] = comps.length;
          stack.push(nb);
        }
      }
      comps.push(comp);
    }

    const rooms: Room[] = [];
    let structured = true;
    for (const comp of comps) {
      const cid = compId[comp[0]!]!;
      const boxes = this.boxes.filter((c) => compId[c] === cid);
      if (boxes.length === 0) continue;
      const goals: number[] = [];
      for (const c of comp) if (this.goal[c] === 1) goals.push(c);
      if (boxes.length !== goals.length) {
        structured = false;
        break;
      }
      let door = -1;
      let entry = -1;
      outer: for (const c of comp) {
        for (let d = 0; d < 4; d++) {
          const nb = stepOf(w, h, c, d);
          if (nb >= 0 && (nb / w | 0) === y0 && wall[nb] === 0) {
            door = c;
            entry = nb;
            break outer;
          }
        }
      }
      if (door < 0) {
        structured = false;
        break;
      }
      rooms.push({ cells: comp, boxes, goals, door, entry });
    }
    if (this.boxes.some((c) => compId[c] < 0)) structured = false;

    // Fallback when the level is not shaped as expected: one room, the whole
    // board, solved by the same search. It will usually run out of budget on a
    // big level, but the answer stays well-formed.
    if (!structured || rooms.length === 0) {
      const allFloor: number[] = [];
      for (let c = 0; c < n; c++) if (wall[c] === 0) allFloor.push(c);
      const allGoals: number[] = [];
      for (let c = 0; c < n; c++) if (this.goal[c] === 1) allGoals.push(c);
      const room: Room = { cells: allFloor, boxes: [...this.boxes], goals: allGoals, door: this.player, entry: this.player };
      const pushes = this.solveRoom(room, new Uint8Array(n), this.player);
      if (pushes === null) return '';
      const boxes = [...this.boxes].sort((a, b) => a - b);
      let moves = '';
      let player = this.player;
      for (const p of pushes) {
        const pushPos = stepOf(w, h, p.from, p.dir ^ 1);
        const walk = pushPos < 0 ? null : this.walkPath(player, pushPos, boxes);
        if (walk === null) return '';
        moves += walk + DIRS[p.dir]!.ch;
        const bi = boxes.indexOf(p.from);
        boxes[bi] = p.to;
        boxes.sort((a, b) => a - b);
        player = p.from;
      }
      return moves;
    }

    rooms.sort((a, b) => a.door - b.door);
    const boxes = [...this.boxes].sort((a, b) => a - b);
    let moves = '';
    let player = this.player;
    for (const room of rooms) {
      const walkIn = this.walkPath(player, room.entry, boxes);
      if (walkIn === null) return '';
      moves += walkIn;
      player = room.entry;
      const roomBoxes = boxes.filter((c) => compId[c] === compId[room.cells[0]!]!);
      const pushes = this.solveRoom({ ...room, boxes: roomBoxes }, hallway, player);
      if (pushes === null) return '';
      for (const p of pushes) {
        const pushPos = stepOf(w, h, p.from, p.dir ^ 1);
        const walk = pushPos < 0 ? null : this.walkPath(player, pushPos, boxes);
        if (walk === null) return '';
        moves += walk + DIRS[p.dir]!.ch;
        const bi = boxes.indexOf(p.from);
        boxes[bi] = p.to;
        boxes.sort((a, b) => a - b);
        player = p.from;
      }
    }
    return moves;
  }
}

function solveLevel(text: string): string {
  return new Level(text).solve();
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
