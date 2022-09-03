TARGET_SQLJS=dist/sqljs.js dist/sqljs.wasm
wasm_dir=sqlite-wasm
# TODO: get this from a command
wasm_dir_abs=/Users/llimllib/code/customsqlite/sqlite-wasm

emcc_opt = -Oz
emcc_flags = $(emcc_opt) \
        -sALLOW_TABLE_GROWTH \
        -sABORTING_MALLOC \
        -sSTRICT_JS \
        -sENVIRONMENT=web \
        -sMODULARIZE \
        -sEXPORTED_RUNTIME_METHODS=@$(wasm_dir_abs)/EXPORTED_RUNTIME_METHODS.fiddle \
        -sDYNAMIC_EXECUTION=0 \
        --minify 0 \
        -I. $(SHELL_OPT) \
        -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_UTF16 -DSQLITE_OMIT_DEPRECATED

wasm: $(TARGET_SQLJS)

$(TARGET_SQLJS): dist \
    $(wasm_dir)/EXPORTED_RUNTIME_METHODS.fiddle \
    $(wasm_dir)/EXPORTED_FUNCTIONS.fiddle
	emcc -o $@ $(emcc_flags) \
        -sEXPORT_NAME=initFiddleModule \
        -sEXPORTED_FUNCTIONS=@$(wasm_dir_abs)/EXPORTED_FUNCTIONS.fiddle \
        -DSQLITE_SHELL_FIDDLE \
		-DSQLITE_EXTRA_INIT=core_init \
        sqlite/sqlite3.c sqlite3-stats.c sqlite/shell.c
# emcc -o ext/wasm/fiddle/fiddle-module.js -Oz -sALLOW_TABLE_GROWTH -sABORTING_MALLOC -sSTRICT_JS -sENVIRONMENT=web -sMODULARIZE -sEXPORTED_RUNTIME_METHODS=@/Users/llimllib/code/tmp/sqlite/ext/wasm/EXPORTED_RUNTIME_METHODS.fiddle -sDYNAMIC_EXECUTION=0 --minify 0 -I. -DSQLITE_ENABLE_FTS4 -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_EXPLAIN_COMMENTS -DSQLITE_ENABLE_UNKNOWN_SQL_FUNCTION -DSQLITE_ENABLE_STMTVTAB -DSQLITE_ENABLE_DBPAGE_VTAB -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_BYTECODE_VTAB -DSQLITE_ENABLE_OFFSET_SQL_FUNC -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_UTF16 -DSQLITE_OMIT_DEPRECATED
# \
#         -sEXPORT_NAME=initFiddleModule \
#         -sEXPORTED_FUNCTIONS=@/Users/llimllib/code/tmp/sqlite/ext/wasm/EXPORTED_FUNCTIONS.fiddle \
#         -DSQLITE_SHELL_FIDDLE \
#                 -DSQLITE_EXTRA_INIT=core_init \
#         sqlite3.c sqlite3-stats.c shell.c
# gzip < ext/wasm/fiddle/fiddle-module.js > ext/wasm/fiddle/fiddle-module.js.gz
# gzip < ext/wasm/fiddle/fiddle-module.wasm > ext/wasm/fiddle/fiddle-module.wasm.gz
# 11:50 AM lexeme:~/code/tmp/sqlite  compile-fiddle-with-stats
# $

$(TARGET_SQLITE3_EXTRA_C): sqlite/sqlite3.c core_init.c
	cat sqlite/sqlite3.c core_init.c > $@

dist:
	mkdir -p dist

.PHONY: clean
clean:
	rm -f dist/*
