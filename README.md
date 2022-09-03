# Building SQLite fiddle with an extension

This branch shows how to build a SQLite fiddle with a SQLite extension linked
in; I've linked in
[sqlite3-stats](https://github.com/nalgeon/sqlean/blob/5da91b7eb73b98fe1d77fc95f215eed9ee38574e/docs/stats.md)
but it can be modified to load any number of extensions.

- [The pieces](#the-pieces)
- [The idea](#the-idea)
- [The steps](#the-steps)
- [Build it yourself](#build-it-yourself)

Following up on [building a WASM sqlite with an embedded
extension](https://github.com/llimllib/wasm_sqlite_with_stats/), I wanted to
build a SQLite fiddle with an embedded extension, using the SQLite javascript
API instead of sql.js.

I applied basically the same technique as in the prior, but using a few more
SQLite pieces and a few less external ones.

## The pieces

- [Emscripten](https://emscripten.org/)
- The [sqlite amalgamation file](https://www.sqlite.org/amalgamation.html) and
  [extension header
  file](https://github.com/sqlite/sqlite/blob/master/src/sqlite3ext.h)
- The [sqlite wasm directory](https://github.com/sqlite/sqlite/tree/master/ext/wasm)
    - for both of the previous, I compiled fresh versions from the current
      sqlite repository at revision `5fc3a8a3`
- The [stats
  file](https://github.com/nalgeon/sqlean/blob/main/src/sqlite3-stats.c) from
  [sqlean](https://github.com/nalgeon/sqlean)
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
- copy the SQLite fiddle html and js in to the `dist` folder

## Build it yourself

`make clean wasm`

Then you go go into `dist` and run a webserver to see the resulting fiddle.

I like to use [`devd`](https://github.com/cortesi/devd), so I switch into
`dist` and run `devd -ol .`, then open up fiddle.html.

Note that to load wasm, you must use a web server; `file://` URLs won't work.
Also you must serve wasm files with a proper mime type; devd will handle this
for you.
