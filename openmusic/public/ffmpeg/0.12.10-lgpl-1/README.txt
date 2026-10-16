OpenMusic audio converter: FFmpeg n5.1.4 compiled to WebAssembly (ffmpeg.wasm core v0.12.10 bindings),
built WITHOUT --enable-gpl: licensed LGPL 2.1 or later (see LICENSE.txt).

Linked libraries: LAME (LGPL), libopus / libvorbis / libogg (BSD), SDL2 (zlib).
Contains audio decoders/encoders and container demuxers only; no video encoders, no GPL components.

Corresponding source and the exact build script:
  FFmpeg:        https://github.com/FFmpeg/FFmpeg/tree/n5.1.4
  ffmpeg.wasm:   https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10
  LAME:          https://github.com/ffmpegwasm/lame  ·  Opus/Vorbis/Ogg: https://github.com/ffmpegwasm
  Build script:  scripts/ffmpeg/build-lgpl.sh in https://github.com/randallerasmus/OpenMusic-foundation
You may rebuild and replace these files with your own build of the same sources.
