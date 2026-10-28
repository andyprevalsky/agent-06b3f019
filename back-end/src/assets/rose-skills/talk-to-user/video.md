# Making video (talk-to-user skill)

`rose video` generates real footage with native audio (Gemini Omni) through
Rose; Rose holds the provider key and bills the clip. Use it whenever the user
wants filmed-looking video. Code-rendered motion graphics (charts, titles,
screen animations) are still yours to build with code; combine both freely.

## How to work

1. Plan the cut as shots of 3-10 s each (one clip per shot), with a sentence
   per shot: subject, action, camera, light, sound.
2. Tell the user the plan with `rose message` before spending.
3. Generate one shot at a time with `--caption`, which also shows the clip to
   the user. Make the caption commentary: what this shot is and what comes
   next. Check a frame yourself (`ffmpeg -ss 1 -i shot1.mp4 -frames:v 1 f.png`)
   and regenerate a bad shot with `--take 2`.
4. Edit in this sandbox with ffmpeg (`sudo apt-get install -y ffmpeg` if missing): trim, concat, crossfades, titles, music
   bed, loudness. Re-encode to one codec, size and frame rate before concat.
5. Show the final cut with `rose display final.mp4 --caption "<what it is>"`
   and give its path in your final response.

## Command

    rose video "<shot description>" --out shot1.mp4 [options] --caption "<commentary>"

| Option          | Values                          | Notes                                                                                   |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `--duration`    | 3-10 (seconds)                  | Steers length; omit for the model's choice (often 10). Longer videos are several shots. |
| `--resolution`  | 360p, 720p (default), 1080p, 4k | 1080p and 4k are upscaled. Use 360p for drafts.                                         |
| `--aspect`      | 16:9 (default), 9:16            | 9:16 for vertical/social.                                                               |
| `--seed`        | 0-2147483647                    | Repeat a look across retakes.                                                           |
| `--first-frame` | image file                      | The exact opening frame (PNG/JPEG/WebP, max 10 MB).                                     |
| `--last-frame`  | image file                      | The exact closing frame; needs `--first-frame`.                                         |
| `--ref`         | image file, up to 3             | Subject, product, character or style to keep consistent.                                |
| `--audio`       | text                            | Music, sound effects, dialogue or ambience wanted.                                      |
| `--no-audio`    | flag                            | Asks for silence; for a guaranteed silent track run `ffmpeg -an`.                       |
| `--avoid`       | text                            | What must not appear (there is no separate negative prompt).                            |
| `--take`        | number                          | A new take of the same request; rerunning without it replays the first take at no cost. |
| `--out`         | file                            | Where the MP4 is written (default `video-<hash>.mp4`).                                  |
| `--caption`     | text                            | Also displays the clip to the user with this commentary.                                |

Duration, audio and avoid are prompt-level: they steer, not guarantee. The
command prints the real duration and cost.

## Cost

Billed per generated second: 360p about $0.034, 720p about $0.10,
1080p about $0.15, 4k about $0.30. A 10 s 720p clip is about $1. Draft at
360p, then render the chosen shots at the final resolution. At most three
clips generate at once per user.

## Limits

- Clips over 20 MB (long 4k) cannot be shown with `--caption`; show a
  compressed copy instead.
- No recognizable real people from images; safety filters can refuse a
  prompt (the error says why). Rephrase rather than retry the same prompt.
