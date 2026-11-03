# R9 Radial Teardown

9気筒空冷星型エンジンを、クランク角ひとつのモデルから組み立てた 3D シミュレーターページ。

## 起動

```bash
python3 -m http.server 5173
```

http://localhost:5173 を開く。

## テスト

```bash
npm test
```

## 構成

- `src/model.js` — エンジンモデル（クランク角の純粋関数）
- `test/model.test.js` — モデルのテスト
- `src/app.js` — 3D シーン、チャート、自動ツアー
- `index.html` — ページとレイアウト

## 参考にした X の投稿

- URL: https://x.com/elvar_official/status/2116174609355571402

以下は作成時に参考にした投稿の文字起こし（受け取ったまま記録）。

---

以下が、該当のX記事（https://x.com/elvar_official/status/2116174609355571402）の全文です。コマンド・プロンプト・手順をそのまま残しています。Claude Codeにそのまま渡せる形に整えてあります。

---

**One free Claude skill builds a working 3D model of any machine, with live gauges and a button for every part.  
Below: the setup and all 9 prompts.**

V8 four-stroke: the throttle opens to 2,400 rpm, cylinder 4 cut open, then cylinder 2, back to idle, played at 1/20 speed

There's a free Claude skill that builds any machine as a 3D simulator. You orbit it, cut it open and watch the part doing the work.

On the V8 the cylinder you track turns to glass and you watch the charge burn inside it while the pressure chart draws its loop.

A V8 simulator like this pulled 3,790,000 views on X. A wildfire tool built with Opus 5.5 pulled 1,640,000. People watch a machine run a lot longer than they read about one.

It works on anything with moving parts, even machines nobody has built. A sandworm 1,300 m long and 190 m across:

Sandworm MK-X: the drill head up close, the arch slamming down, the buried body in x-ray, then a second breach

The panels read the worm's real pose. The head section turns with the drill, the depth profile follows the buried body and the map draws its track.

A robotic jellyfish:

Hydromedusa HM-4: limb 07 opens down to its mesh, the dome splits into its 4 layers, the spine bursts apart

Every subsystem is a button. Press one and that part comes apart while the rest of the body steps aside.

I built 7 of these in 2 days. 3 ship inside the skill: the V8, a Cessna landing gear and a Strandbeest.

The skill is called teardown. It's free and runs inside Claude Code.

---

### What You're Building

A simulator is one HTML page, 800 KB, that works offline. Every one I built has the same 6 parts. Here they are on a walking robot:

HX-7: the body rises in a wave gait, ripple with a strafe and a turn left, then tripod sped up to 1.5×, all driven by the cursor

- **The machine.** Built from code: a hexagonal chassis on 6 legs, 18 joints, red servo housings, slotted femurs, shins ending in a cone tip.
- **The model.** One solver for every leg. It plans each step a second ahead. The legs, the panels and the floor all read from it.
- **The panels.** Joint torque, the height of every foot, the load on each of the 6 legs, solver time, servo temperature.
- **The buttons.** Tripod, ripple and wave gaits, a direction pad, WASD keys, sliders for speed, stride and body height.
- **The window.** The floor shows the solver at work: lines to every planted foot, a marker where each foot will land, swing trails.
- **The tour.** Left alone, a cursor drives the page by itself. Click anything and it hands you control. 25 seconds of quiet and the tour comes back.

---

### What You Need

- **Claude Code** on any plan that includes it. I ran everything on Opus 5.5.
- **Node.js 20 or newer.**
- **ffmpeg and Python 3**, only for the video and the sound. Claude Code installs both if you ask.

The skill is **teardown**: MIT licence, free, 3 machines inside. It's built on whaleyxbt's claude-motion, which gave it frame capture and the sound engine.

---

### Step 1. Install the Skill

```bash
npx skills add elvarofficial/teardown -g -a claude-code
```

Then, once, in the installed folder:

```bash
cd ~/.claude/skills/teardown && npm install && npx playwright install chromium
```

Open Claude Code and type `/teardown`.

---

### Step 2. Pick the Machine and Find a Reference

This step decides everything. I learned it the hard way.

I asked for a pangolin, an armadillo and a scorpion with nothing to work from. All 3 came out as generic toys. Then I gave the same model one clip of a real V8 simulator and it rebuilt the engine panel by panel.

So pick a machine with one moving input and real numbers, then find one picture of it: a cutaway from a manual, a photo, a clip. 5 I haven't built yet:

1. A bicycle derailleur shifting across 11 sprockets
2. A mechanical watch escapement ticking at 4 Hz
3. A car differential on a turn
4. A sewing machine making a lockstitch
5. An excavator arm digging one bucket

---

### Step 3. Build the Machine

Paste this into Claude Code. Swap everything in [brackets].

```
/teardown Build [the Cessna 337 main landing gear] as an interactive 3D simulator. Reference attached: [a cutaway drawing of the gear].

Build it from code in real units: [the main plate, the hydraulic actuator, the rack, the pinion on its output shaft, the universal joints, the side tubes, the spring legs and the wheels].

Before you draw anything, write the model as pure functions of one input: [stroke from 0 to 1]. Use the real numbers: [the rack travels 201 mm, the pinion has 32 teeth at module 4 mm, so the legs turn exactly 180°]. Check them by hand and show me the check. If you are not sure a number is real, say so and tell me where it comes from.

Every part, every panel and every label reads from that one model. Nothing is animated by hand.
```

Why it holds:

- **The model comes first.** The gear, the gauges and the timeline read one function, so they can't drift apart.
- **One input.** A whole mechanism posed from one number is a mechanism. 12 parts animated by hand are 12 animations.

Here's what that prompt built:

Cessna 337 main gear: it drops and locks for a landing, then folds away after takeoff, in x-ray, exploded and cut open

One cylinder pushes a rack 201 mm. The rack turns a 32-tooth gear exactly half a turn. The legs swing back through 180° into the airframe.

The numbers check out on paper. 32 teeth at a 4 mm module is a 128 mm gear. Half its circumference is 201 mm.

The V8 and the Strandbeest came out of this same prompt with new brackets. The Strandbeest's model is Theo Jansen's 11 link lengths from 1990: turn the crank and every joint follows by circle intersection.

---

### Step 4. Build the Console

```
Lay out a console around the machine at 1600×900:
- the title and the main live number top left, big: [engine speed in rpm]
- live charts that move with the machine: [valve lift over 720° of crank, the pressure-volume loop of the tracked cylinder]
- a schematic panel that redraws the mechanism in 2D from the same model
- one button per subsystem: isolate it, cut it, show it alone
- camera views as buttons: [hero, front, side, top, inside the valley]
- callouts with thin leader lines into the parts they name
Every panel redraws from the frame's state. No number on screen is typed in.
```

A chart that moves with the part is the reason people stay. The pressure loop on the V8 closes once every 720° of crank. You watch it close.

---

### Step 5. Give It the Look

```
Style: a clean study model on a pale studio.
- light background, soft shadows on an invisible floor, one accent colour for the part that is working right now
- the machine fills 60 to 70% of its view
- dark parts glossy, liners glass, metal roughness at least 0.45 so it never streaks white
- if a part is near-white, give it a thin ink outline or a darker ground
- pick the camera for the mechanism: if it collapses into a lattice face-on, use a 3/4 view
```

Every line is a fix. The Strandbeest's white tubes vanished into a cream background until I moved it onto sand and gave it an ink outline. Seen face-on its 20 legs turned into a fence, so the camera sits at 3/4 along the spine. The dark version of my rabbit scene lost the feed's first second.

Strandbeest SB-10: the wind drops from 12 to 6 m/s, one leg isolated bar by bar, all 20 foot loops traced

---

### Step 6. Check It Like a Critic

```
Before you show me anything:
1. Render a still at every beat of the tour and read each one: a part passing through another, a part floating off its mount, a label covering what it names, a number that disagrees with the pose.
2. Scrub every transition at 0.2 s steps and look for a jump.
3. Fix collisions with a number in the parameter block. Never hide them with the camera.
Tell me what you checked and what you fixed. Show me the stills.
```

The stills caught 2 bugs I would have shipped. A rabbit's face pushed through the wall of its hat until one number, 0.222 m, put it back inside. The hexapod's leg flew off on every gait change until its feet aimed at the next real foothold.

---

### Step 7. Make It a Page You Drive

```
Make the simulator a page people drive:
- the tour from the film plays by itself, with a cursor that walks to each button and presses it
- any click, drag, scroll or key hands control to the visitor; 25 seconds of quiet hands it back
- drag to orbit, scroll to zoom, a key to hide the panels
- warm every shader before the first frame so the page never freezes
- test it on an integrated GPU and add quality steps: no ambient occlusion, a lower pixel ratio, smaller shadows, panels redrawn every other frame
```

The integrated GPU is the test most people skip. The hexapod ran at 15 fps on an integrated GPU. After the quality steps it ran at 75. On a sand dune page the slow part was one shader computing the same displacement 5 times per vertex.

---

### Step 8. Turn It Into a Video

**Record it:**

```
Record the tour: render(t) has to be a pure function of time, so draw every frame at 60 fps at 1920×1080 in headless Chrome and pipe it into ffmpeg as H.264, yuv420p, faststart. Then show me a contact sheet of every beat.
```

**Score it:**

```
Score it in code on the same timeline: [Am9 chords at 92 bpm, a soft thump on every power stroke so the beat tightens when the throttle opens, a quiet click on every button press, rising air under the throttle drag]. Master to -14 LUFS with the true peak under -1 dB and mux it into the video.
```

A screen recorder drops frames when the GPU works hard. A seeked tour can't. The V8 film comes out at 26 seconds with 189 sounds. Every thump lands on its power stroke.

---

### Step 9. Put It Online

```
Publish the simulator as a page:
- keep the HTML under 1 MB; move any large model out as a file next to the page
- a 1200×630 preview card from the best frame, with absolute image URLs
- deploy it to Vercel
```

The 1 MB line comes from a miss. My rabbit page weighed 15.9 MB with its models inside and X never showed the link card. With the models moved out it weighed 967 KB and the card showed up.

---

### Bonus. Let Them Break It

```
Add one slider for [the wind, 0 to 15 m/s] and run the model live when it moves: [a light breeze barely turns the crank, a gale makes the legs blur]. Show it on the same panels.
```

Whoever can push the machine past its limit learns what every number does.

---

All 6 run in your browser, free: visual-learning.app. Press the buttons yourself.

On a phone or a laptop's built-in graphics the first load takes a few seconds while the shaders compile. After that the page lowers its own quality to keep the frame rate up.

The 3 in the skill are open source: github.com/elvarofficial/teardown

---

これで全文＋コマンド・プロンプトがそのまま残った状態です。Claude Codeに貼り付けて使ってください。
