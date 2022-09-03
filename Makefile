TARGET_SQLJS=dist/sqljs.js dist/sqljs.wasm
TARGET_SQLITE3_EXTRA_C=dist/sqlite3-extra.c
TARGET_SQLJS_JS=dist/sqljs.js

# The below is mostly borrowed from https://github.com/sql-js/sql.js/blob/master/Makefile
SQLJS_CFLAGS = \
	-O2 \
	-DSQLITE_OMIT_LOAD_EXTENSION \
	-DSQLITE_DISABLE_LFS \
	-DSQLITE_ENABLE_JSON1 \
	-DSQLITE_THREADSAFE=0 \
	-DSQLITE_ENABLE_NORMALIZE \
	-DSQLITE_EXTRA_INIT=core_init

SQLJS_EMFLAGS = \
	--memory-init-file 0 \
	-s RESERVED_FUNCTION_POINTERS=64 \
	-s ALLOW_TABLE_GROWTH=1 \
	-s EXPORTED_FUNCTIONS=@wasm/exported_functions.json \
	-s EXPORTED_RUNTIME_METHODS=@wasm/exported_runtime_methods.json \
	-s SINGLE_FILE=0 \
	-s NODEJS_CATCH_EXIT=0 \
	-s NODEJS_CATCH_REJECTION=0 \
	-s LLD_REPORT_UNDEFINED

SQLJS_EMFLAGS_DEBUG = \
	-s INLINING_LIMIT=1 \
	-s ASSERTIONS=1 \
	-O1

SQLJS_EMFLAGS_WASM = \
	-s WASM=1 \
	-s ALLOW_MEMORY_GROWTH=1

wasm: $(TARGET_SQLJS)

$(TARGET_SQLJS): dist $(shell find wasm/ -type f) sqlite3-stats.c $(TARGET_SQLITE3_EXTRA_C)
	emcc $(SQLJS_CFLAGS) \
		$(SQLJS_EMFLAGS) \
		$(SQLJS_EMFLAGS_DEBUG) \
		$(SQLJS_EMFLAGS_WASM) \
		-I./sqlite -I./ \
		sqlite3-stats.c $(TARGET_SQLITE3_EXTRA_C) \
		--pre-js wasm/api.js \
		-o $(TARGET_SQLJS_JS)
	mv $(TARGET_SQLJS_JS) tmp.js
	cat wasm/shell-pre.js tmp.js wasm/shell-post.js > $(TARGET_SQLJS_JS)
	rm tmp.js


$(TARGET_SQLITE3_EXTRA_C): sqlite/sqlite3.c core_init.c
	cat sqlite/sqlite3.c core_init.c > $@

dist:
	mkdir -p dist

clean:
	rm -f dist/*
