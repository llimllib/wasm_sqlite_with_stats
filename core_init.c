/*
  This file is appended to the end of a sqlite3.c amalgamation
  file to include sqlite3_stats functions/tables statically in
  a build, which is used to build a wasm version of sqlite with
  stats included
*/
#include "sqlite-stats.h"
int core_init(const char *dummy) {
  return sqlite3_auto_extension((void *) sqlite3_stats_init);
}
