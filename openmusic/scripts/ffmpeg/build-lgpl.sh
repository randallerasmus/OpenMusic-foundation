#!/bin/bash
# OpenMusic's LGPL audio-only ffmpeg.wasm core, built from ffmpeg.wasm v0.12.10's own scripts.
# Differences from the official @ffmpeg/core: no --enable-gpl and no GPL libraries (x264, x265, postproc);
# no video codecs or subtitle/font libraries; only LAME (LGPL), Opus/Vorbis/Ogg (BSD) are linked.
# Runs inside emscripten/emsdk:3.1.40 (the image ffmpeg.wasm uses) with /work mounted.
set -euo pipefail
W=/work; R=$W/ffmpeg.wasm
export INSTALL_DIR=$W/opt
export CFLAGS="-I$INSTALL_DIR/include -O3 -msimd128"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-L$INSTALL_DIR/lib $CFLAGS"
export EM_PKG_CONFIG_PATH="$INSTALL_DIR/lib/pkgconfig:/emsdk/upstream/emscripten/system/lib/pkgconfig"
export PKG_CONFIG_PATH="$EM_PKG_CONFIG_PATH"
export FFMPEG_ST=yes FFMPEG_MT=
mkdir -p $W/src $INSTALL_DIR
command -v autoreconf >/dev/null || { apt-get update -qq && apt-get install -y -qq pkg-config autoconf automake libtool ragel >/dev/null; }

lib(){ # name repo ref script
  local d=$W/src/$1
  if [ -f $W/src/.done-$1 ]; then echo "== $1 already built"; return; fi
  echo "== building $1"; rm -rf $d
  git clone -q --depth 1 --branch $3 https://github.com/$2.git $d
  (cd $d && bash -x $R/build/$4) > $W/src/$1.log 2>&1 || { tail -40 $W/src/$1.log; exit 1; }
  touch $W/src/.done-$1
}
lib lame ffmpegwasm/lame master lame.sh
lib ogg ffmpegwasm/Ogg v1.3.4 ogg.sh
lib opus ffmpegwasm/opus v1.3.1 opus.sh
lib vorbis ffmpegwasm/vorbis v1.3.3 vorbis.sh

F=$W/src/FFmpeg
if [ ! -f $W/src/.done-ffmpeg ]; then
  echo "== configuring + building FFmpeg n5.1.4 (LGPL, audio-only)"
  embuilder build sdl2 >/dev/null
  # Upstream's ffmpeg.sh runs an unbounded `make -j`, which runs out of memory in a VM; cap the parallel jobs.
  sed 's/emmake make -j$/emmake make -j${JOBS:-6}/' $R/build/ffmpeg.sh > $W/src/ffmpeg-build.sh
  if [ -f $F/ffbuild/config.mak ]; then
    echo "== FFmpeg already configured; resuming compile"
    cd $F && emmake make -j${JOBS:-6} >> $W/src/ffmpeg-configure-make.log 2>&1 || { grep -n "error:" $W/src/ffmpeg-configure-make.log | tail -20; exit 1; }
    touch $W/src/.done-ffmpeg
  fi
fi
if [ ! -f $W/src/.done-ffmpeg ]; then
  rm -rf $F; git clone -q --depth 1 --branch n5.1.4 https://github.com/FFmpeg/FFmpeg.git $F
  cd $F
  bash -x $W/src/ffmpeg-build.sh \
    --enable-libmp3lame --enable-libvorbis --enable-libopus \
    --disable-network --disable-devices --disable-hwaccels --disable-postproc --disable-iconv \
    --disable-encoders --enable-encoder=libmp3lame,aac,alac,flac,pcm_s16le,libopus,libvorbis \
    --disable-decoders --enable-decoder='aac*,ac3*,eac3*,alac,ape,atrac*,cook,dca,dsd*,flac,gsm*,mlp,truehd,mp1*,mp2*,mp3*,nellymoser,opus,libopus,qdm2,ra_*,speex,tta,vorbis,wavpack,wma*,amrnb,amrwb,pcm_*,adpcm_*,sipr,dolby_e' \
    --disable-muxers --enable-muxer=mp3,ipod,mp4,adts,wav,flac,ogg,opus \
    --disable-filters --enable-filter=abuffer,abuffersink,aformat,anull,aresample,atrim,apad,asetpts,volume,amix,buffer,buffersink,format,null,trim,setpts \
    --disable-protocols --enable-protocol=file,pipe \
    > $W/src/ffmpeg-configure-make.log 2>&1 || { grep -n "error:" $W/src/ffmpeg-configure-make.log | tail -20; exit 1; }
  touch $W/src/.done-ffmpeg
fi
cd $F
grep -E "^License:" ffbuild/config.log 2>/dev/null || ./configure --help >/dev/null 2>&1; grep -h "^License" $W/src/ffmpeg-configure-make.log || true

echo "== linking ffmpeg-core (single-thread)"
rm -rf src && mkdir -p src && cp -r $R/src/bind $R/src/fftools src/
# Same link step as build/ffmpeg-wasm.sh, minus libpostproc (GPL, not built).
sed -e '/-Llibpostproc/d' -e '/-lpostproc/d' $R/build/ffmpeg-wasm.sh > link.sh
LIBS="-lmp3lame -logg -lvorbis -lvorbisenc -lvorbisfile -lopus"
mkdir -p dist/esm dist/umd
bash -x link.sh $LIBS -o dist/umd/ffmpeg-core.js > $W/src/link-umd.log 2>&1 || { tail -40 $W/src/link-umd.log; exit 1; }
bash -x link.sh $LIBS -sEXPORT_ES6 -o dist/esm/ffmpeg-core.js > $W/src/link-esm.log 2>&1 || { tail -40 $W/src/link-esm.log; exit 1; }
rm -rf $W/out && mkdir -p $W/out && cp -r dist/* $W/out/
cp $F/COPYING.LGPLv2.1 $W/out/ 2>/dev/null || true
ls -la $W/out/esm $W/out/umd
echo BUILD-OK
