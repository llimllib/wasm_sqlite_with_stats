# Building a WASM sqlite with an embedded extension

I wanted to build a wasm version of sqlite, but I also wanted to include [an
extension](https://github.com/nalgeon/sqlean/blob/main/docs/stats.md) in it.

As far as I know, you can't dynamically load extensions into the wasm version
of sqlite, so I wanted to build a version that had it statically linked in.

As I don't know C very well, this seemed pretty hopeless - but thankfully I
found [sqlite-lines](https://github.com/asg017/sqlite-lines/) by @asg017 (who
also kindly [helped me on
twitter](https://twitter.com/agarcia_me/status/1565775569664430080)), which
[demonstrated](https://observablehq.com/@asg017/introducing-sqlite-lines) that
it was possible.

- [The pieces](#the-pieces)
- [The idea](#the-idea)
- [The steps](#the-steps)
- [Build it yourself](#build-it-yourself)
- [SQLite fiddle with extension](#sqlite-fiddle-with-extension)

## The pieces

To build it, I followed in Alex's footsteps and used these pieces:

- [Emscripten](https://emscripten.org/)
- The [sqlite amalgamation file](https://www.sqlite.org/amalgamation.html) and
  [extension header
  file](https://github.com/sqlite/sqlite/blob/master/src/sqlite3ext.h)
  - I just copied the versions Alex used
- The [stats
  file](https://github.com/nalgeon/sqlean/blob/main/src/sqlite3-stats.c) from
  sqlean
- The [sqlite wasm API](https://github.com/sql-js/sql.js/) from sql.js
- The [Makefile](https://github.com/asg017/sqlite-lines/blob/main/Makefile) and
  [core-init.c](https://github.com/asg017/sqlite-lines/blob/main/core_init.c)
  file from [sqlite-lines](https://github.com/asg017/sqlite-lines)

## The idea

The basic idea of building a sqlite that has an extension statically linked is
that you can use an undocumented C preprocessor macro called
`SQLITE_EXTRA_INIT` which will, if defined, load extra code into sqlite after
finishing up its own initialization. If you point `SQLITE_EXTRA_INIT` at a
function that calls
[`sqlite3_auto_extension`](https://www.sqlite.org/c3ref/auto_extension.html)
with a pointer to your extension's init function, it will load right after
sqlite loads itself and the functions defined within will be available to
sqlite.

## The steps

To make the idea happen, this code:

- sets `SQLITE_EXTRA_INIT` [here](https://github.com/llimllib/wasm_sqlite_with_stats/blob/83bdf9e1bf6808590a281d8f2d32cafafa750b33/Makefile#L13), pointing to the `core_init` function
- defines the `core_init` function [here](https://github.com/llimllib/wasm_sqlite_with_stats/blob/83bdf9e1bf6808590a281d8f2d32cafafa750b33/core_init.c)
- makes `core_init` available to sqlite by [appending it](https://github.com/llimllib/wasm_sqlite_with_stats/blob/83bdf9e1bf6808590a281d8f2d32cafafa750b33/Makefile#L52) to the end of the amalgamation file as the first step of our build process
- uses emscripten [to build](https://github.com/llimllib/wasm_sqlite_with_stats/blob/83bdf9e1bf6808590a281d8f2d32cafafa750b33/Makefile#L38) sqlite3-stats.c and the amalgamation file (with the appended `SQLITE_EXTRA_INIT` bit) together into a wasm output

Finally, I made an [HTML page](https://github.com/llimllib/wasm_sqlite_with_stats/blob/e057459ef636de80091bbc781751055b9bf5395d/index.html) that makes the most basic possible use of the sqlite binary to make sure that the stats extension has been loaded.

## Build it yourself

`make clean wasm`

To visit the web page that demonstrates how to use the file, serve the `dist`
directory with a web server that serves proper mime types. I like to use
[`devd`](https://github.com/cortesi/devd), so I run `devd -ol dist`

## SQLite fiddle with extension

I used the knowledge I gained in this effort to a [SQLite fiddle with an embedded extension](https://llimllib.github.io/wasm_sqlite_with_stats/). Instructions for building the fiddle can be found in the [build-fiddle](https://github.com/llimllib/wasm_sqlite_with_stats/tree/build-fiddle) branch.
