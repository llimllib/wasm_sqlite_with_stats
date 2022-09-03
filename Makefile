TARGET_SQLJS=dist/fiddle-module.js
TARGET_SQLITE3_EXTRA_C=dist/sqlite.c
wasm_dir=sqlite-wasm
wasm_dir_abs=$(shell realpath sqlite-wasm)

# flags copied from the sqlite makefile
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

# build the wasm and js sqlite files
$(TARGET_SQLJS): dist $(TARGET_SQLITE3_EXTRA_C)\
	$(wasm_dir)/EXPORTED_RUNTIME_METHODS.fiddle \
	$(wasm_dir)/EXPORTED_FUNCTIONS.fiddle
	emcc -o $@ $(emcc_flags) \
		-sEXPORT_NAME=initFiddleModule \
		-sEXPORTED_FUNCTIONS=@$(wasm_dir_abs)/EXPORTED_FUNCTIONS.fiddle \
		-DSQLITE_SHELL_FIDDLE \
		-DSQLITE_EXTRA_INIT=core_init \
		$(TARGET_SQLITE3_EXTRA_C) sqlite3-stats.c sqlite/shell.c
	cp sqlite-wasm/fiddle/* dist/

# Append a bit of code that points SQLITE_EXTRA_INIT towards the init function
# of sqlite3-stats.c; see core_init.c
$(TARGET_SQLITE3_EXTRA_C): sqlite/sqlite3.c core_init.c
	cat sqlite/sqlite3.c core_init.c > $@

# publish the fiddle to gh-pages. Accessible at
# https://llimllib.github.io/wasm_sqlite_with_stats/
publish: | clean wasm
	TMP=$$(mktemp -d) && \
		cp dist/* $${TMP} && \
		git branch -D gh-pages ; \
		git switch --orphan gh-pages && \
		mv $${TMP}/* . && \
		mv fiddle.html index.html && \
		git add *.{html,js,wasm,css} && \
		git commit -m "deploy fiddle" && \
		git push -f origin gh-pages && \
		git switch build-fiddle

dist:
	mkdir -p dist

.PHONY: clean
clean:
	rm -f dist/*
