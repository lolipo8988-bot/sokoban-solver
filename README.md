# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/lolipo8988-bot/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/lolipo8988-bot/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: it reads each level from `/input/<id>/level.txt`
and writes the fewest-push move sequence to `/output/<id>/solution.txt`.

Entry for the [$100 sokoban-solver-01-run-20261121 bounty on make.fun](https://make.fun/bounty/sokoban-solver-01-run-20261121)
(10 places, $10 each).

> Sign up with my referral link: [https://make.fun/r/7n5rt0bc](https://make.fun/r/7n5rt0bc)
> — referral code `7n5rt0bc`.

## How it works

The generated levels are a one-wide hallway with one to four rooms off it,
each room holding three or four boxes and as many goals behind a single door.
A box pushed out of a room through its door can never come back, so every box
stays in its room and a level's push-optimal count is the sum of its rooms'
optima. The solver leans on that: it solves each room on its own,
push-optimally, and stitches the rooms together with shortest player walks.

Each room is solved with an A* search over pushes. A state is the room's
boxes plus the region the player can reach (walks between pushes are free).
The search is guided by the cheapest assignment of boxes to goals by
shortest-path distance, and prunes positions no push can save: dead squares
(found by pulling boxes back from the goals), corner deadlocks, 2x2 blocks of
boxes and walls, and boxes stuck against a wall segment that holds no goal.
The budget is a fixed number of node expansions, never the clock, so two runs
always give the same answer; if the optimal search runs out of budget, a
weighted search and then a greedy search try for any solution instead.

## Local results

- Practice set: 5/5 solved, every instance in exactly its push-optimal count
  (13, 16, 29, 47, 60 pushes) — practice score 1,000,000, in about 0.5s for
  the whole set.
- House baseline plain-astar 1.0.0 on the same practice set: 200,000 (only
  i001 solved).
- Ten further sets drawn fresh from the kit's own generator: all 1,000,000,
  each under 0.5s.
- Two runs on the practice set produce byte-identical outputs.

## Run it

```sh
node main.ts   # reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR/<id>/solution.txt
```

Node 22.18 or later. No dependencies, no network, no build step.
