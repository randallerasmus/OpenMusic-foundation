// Human-readable identity of the running build, e.g. "0.1.0 · build 15 · a1b2c3d" (or "· dev" locally).
export const BUILD=__OPENMUSIC_BUILD__;
export const buildLabel=`${BUILD.version} · ${BUILD.build==='dev'?'dev':`build ${BUILD.build}`} · ${BUILD.commit.slice(0,7)}`;
