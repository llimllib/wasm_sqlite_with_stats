/* BEGIN FILE: api/sqlite3-api-prologue.js */
/*
  2022-05-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file is intended to be combined at build-time with other
  related code, most notably a header and footer which wraps this whole
  file into an Emscripten Module.postRun() handler which has a parameter
  named "Module" (the Emscripten Module object). The exact requirements,
  conventions, and build process are very much under construction and
  will be (re)documented once they've stopped fluctuating so much.

  Specific goals of this project:

  - Except where noted in the non-goals, provide a more-or-less
    feature-complete wrapper to the sqlite3 C API, insofar as WASM
    feature parity with C allows for. In fact, provide at least 3
    APIs...

    1) Bind a low-level sqlite3 API which is as close to the native
       one as feasible in terms of usage.

    2) A higher-level API, more akin to sql.js and node.js-style
       implementations. This one speaks directly to the low-level
       API. This API must be used from the same thread as the
       low-level API.

    3) A second higher-level API which speaks to the previous APIs via
       worker messages. This one is intended for use in the main
       thread, with the lower-level APIs installed in a Worker thread,
       and talking to them via Worker messages. Because Workers are
       asynchronouns and have only a single message channel, some
       acrobatics are needed here to feed async work results back to
       the client (as we cannot simply pass around callbacks between
       the main and Worker threads).

  - Insofar as possible, support client-side storage using JS
    filesystem APIs. As of this writing, such things are still very
    much TODO. Initial testing with using IndexedDB as backing storage
    showed it to work reasonably well, but it's also too easy to
    corrupt by using a web page in two browser tabs because IndexedDB
    lacks the locking features needed to support that.

  Specific non-goals of this project:

  - As WASM is a web-centric technology and UTF-8 is the King of
    Encodings in that realm, there are no currently plans to support
    the UTF16-related sqlite3 APIs. They would add a complication to
    the bindings for no appreciable benefit. Though web-related
    implementation details take priority, the lower-level WASM module
    "should" work in non-web WASM environments.

  - Supporting old or niche-market platforms. WASM is built for a
    modern web and requires modern platforms.

  - Though scalar User-Defined Functions (UDFs) may be created in
    JavaScript, there are currently no plans to add support for
    aggregate and window functions.

  Attribution:

  This project is endebted to the work of sql.js:

  https://github.com/sql-js/sql.js

  sql.js was an essential stepping stone in this code's development as
  it demonstrated how to handle some of the WASM-related voodoo (like
  handling pointers-to-pointers and adding JS implementations of
  C-bound callback functions). These APIs have a considerably
  different shape than sql.js's, however.
*/

/**
   This global symbol is is only a temporary measure: the JS-side
   post-processing will remove that object from the global scope when
   setup is complete. We require it there temporarily in order to glue
   disparate parts together during the loading of the API (which spans
   several components).

   This function requires a configuration object intended to abstract
   away details specific to any given WASM environment, primarily so
   that it can be used without any _direct_ dependency on Emscripten.
   (That said, OO API #1 requires, as of this writing, Emscripten's
   virtual filesystem API. Baby steps.)
*/
self.sqlite3ApiBootstrap = function(config){
  'use strict';

  /** Throws a new Error, the message of which is the concatenation
      all args with a space between each. */
  const toss = (...args)=>{throw new Error(args.join(' '))};

  /**
     Returns true if n is a 32-bit (signed) integer, else
     false. This is used for determining when we need to switch to
     double-type DB operations for integer values in order to keep
     more precision.
  */
  const isInt32 = function(n){
    return ('bigint'!==typeof n /*TypeError: can't convert BigInt to number*/)
      && !!(n===(n|0) && n<=2147483647 && n>=-2147483648);
  };

  /** Returns v if v appears to be a TypedArray, else false. */
  const isTypedArray = (v)=>{
    return (v && v.constructor && isInt32(v.constructor.BYTES_PER_ELEMENT)) ? v : false;
  };

  /**
     Returns true if v appears to be one of our bind()-able
     TypedArray types: Uint8Array or Int8Array. Support for
     TypedArrays with element sizes >1 is TODO.
  */
  const isBindableTypedArray = (v)=>{
    return v && v.constructor && (1===v.constructor.BYTES_PER_ELEMENT);
  };

  /**
     Returns true if v appears to be one of the TypedArray types
     which is legal for holding SQL code (as opposed to binary blobs).

     Currently this is the same as isBindableTypedArray() but it
     seems likely that we'll eventually want to add Uint32Array
     and friends to the isBindableTypedArray() list but not to the
     isSQLableTypedArray() list.
  */
  const isSQLableTypedArray = (v)=>{
    return v && v.constructor && (1===v.constructor.BYTES_PER_ELEMENT);
  };

  /** Returns true if isBindableTypedArray(v) does, else throws with a message
      that v is not a supported TypedArray value. */
  const affirmBindableTypedArray = (v)=>{
    return isBindableTypedArray(v)
      || toss("Value is not of a supported TypedArray type.");
  };

  const utf8Decoder = new TextDecoder('utf-8');
  const typedArrayToString = (str)=>utf8Decoder.decode(str);

  /**
     An Error subclass specifically for reporting Wasm-level malloc()
     failure and enabling clients to unambiguously identify such
     exceptions.
  */
  class WasmAllocError extends Error {
    constructor(...args){
      super(...args);
      this.name = 'WasmAllocError';
    }
  };

  /** 
      The main sqlite3 binding API gets installed into this object,
      mimicking the C API as closely as we can. The numerous members
      names with prefixes 'sqlite3_' and 'SQLITE_' behave, insofar as
      possible, identically to the C-native counterparts, as documented at:

      https://www.sqlite.org/c3ref/intro.html

      A very few exceptions require an additional level of proxy
      function or may otherwise require special attention in the WASM
      environment, and all such cases are document here. Those not
      documented here are installed as 1-to-1 proxies for their C-side
      counterparts.
  */
  const capi = {
    /**
       An Error subclass which is thrown by this object's alloc() method
       on OOM.
    */
    WasmAllocError: WasmAllocError,
    /**
       The API's one single point of access to the WASM-side memory
       allocator. Works like malloc(3) (and is likely bound to
       malloc()) but throws an WasmAllocError if allocation fails. It is
       important that any code which might pass through the sqlite3 C
       API NOT throw and must instead return SQLITE_NOMEM (or
       equivalent, depending on the context).

       That said, very few cases in the API can result in
       client-defined functions propagating exceptions via the C-style
       API. Most notably, this applies ot User-defined SQL Functions
       (UDFs) registered via sqlite3_create_function_v2(). For that
       specific case it is recommended that all UDF creation be
       funneled through a utility function and that a wrapper function
       be added around the UDF which catches any exception and sets
       the error state to OOM. (The overall complexity of registering
       UDFs essentially requires a helper for doing so!)
    */
    alloc: undefined/*installed later*/,
    /**
       The API's one single point of access to the WASM-side memory
       deallocator. Works like free(3) (and is likely bound to
       free()).
    */
    dealloc: undefined/*installed later*/,
    /**
       When using sqlite3_open_v2() it is important to keep the following
       in mind:

       https://www.sqlite.org/c3ref/open.html

       - The flags for use with its 3rd argument are installed in this
       object using the C-cide names, e.g. SQLITE_OPEN_CREATE.

       - If the combination of flags passed to it are invalid,
       behavior is undefined. Thus is is never okay to call this
       with fewer than 3 arguments, as JS will default the
       missing arguments to `undefined`, which will result in a
       flag value of 0. Most of the available SQLITE_OPEN_xxx
       flags are meaningless in the WASM build, e.g. the mutext-
       and cache-related flags, but they are retained in this
       API for consistency's sake.

       - The final argument to this function specifies the VFS to
       use, which is largely (but not entirely!) meaningless in
       the WASM environment. It should always be null or
       undefined, and it is safe to elide that argument when
       calling this function.
    */
    sqlite3_open_v2: function(filename,dbPtrPtr,flags,vfsStr){}/*installed later*/,
    /**
       The sqlite3_prepare_v3() binding handles two different uses
       with differing JS/WASM semantics:

       1) sqlite3_prepare_v3(pDb, sqlString, -1, prepFlags, ppStmt [, null])

       2) sqlite3_prepare_v3(pDb, sqlPointer, sqlByteLen, prepFlags, ppStmt, sqlPointerToPointer)

       Note that the SQL length argument (the 3rd argument) must, for
       usage (1), always be negative because it must be a byte length
       and that value is expensive to calculate from JS (where only
       the character length of strings is readily available). It is
       retained in this API's interface for code/documentation
       compatibility reasons but is currently _always_ ignored. With
       usage (2), the 3rd argument is used as-is but is is still
       critical that the C-style input string (2nd argument) be
       terminated with a 0 byte.

       In usage (1), the 2nd argument must be of type string,
       Uint8Array, or Int8Array (either of which is assumed to
       hold SQL). If it is, this function assumes case (1) and
       calls the underyling C function with the equivalent of:

       (pDb, sqlAsString, -1, prepFlags, ppStmt, null)

       The pzTail argument is ignored in this case because its result
       is meaningless when a string-type value is passed through
       (because the string goes through another level of internal
       conversion for WASM's sake and the result pointer would refer
       to that transient conversion's memory, not the passed-in
       string).

       If the sql argument is not a string, it must be a _pointer_ to
       a NUL-terminated string which was allocated in the WASM memory
       (e.g. using cwapi.wasm.alloc() or equivalent). In that case,
       the final argument may be 0/null/undefined or must be a pointer
       to which the "tail" of the compiled SQL is written, as
       documented for the C-side sqlite3_prepare_v3(). In case (2),
       the underlying C function is called with the equivalent of:

       (pDb, sqlAsPointer, (sqlByteLen||-1), prepFlags, ppStmt, pzTail)

       It returns its result and compiled statement as documented in
       the C API. Fetching the output pointers (5th and 6th
       parameters) requires using capi.wasm.getMemValue() (or
       equivalent) and the pzTail will point to an address relative to
       the sqlAsPointer value.

       If passed an invalid 2nd argument type, this function will
       return SQLITE_MISUSE but will unfortunately be able to return
       any additional error information because we have no way to set
       the db's error state such that this function could return a
       non-0 integer and the client could call sqlite3_errcode() or
       sqlite3_errmsg() to fetch it. See the RFE at:

       https://sqlite.org/forum/forumpost/f9eb79b11aefd4fc81d

       The alternative would be to throw an exception for that case,
       but that would be in strong constrast to the rest of the
       C-level API and seems likely to cause more confusion.

       Side-note: in the C API the function does not fail if provided
       an empty string but its result output pointer will be NULL.
    */
    sqlite3_prepare_v3: function(dbPtr, sql, sqlByteLen, prepFlags,
                                 stmtPtrPtr, strPtrPtr){}/*installed later*/,

    /**
       Equivalent to calling sqlite3_prapare_v3() with 0 as its 4th argument.
    */
    sqlite3_prepare_v2: function(dbPtr, sql, sqlByteLen, stmtPtrPtr,
                                 strPtrPtr){}/*installed later*/,

    /**
       Various internal-use utilities are added here as needed. They
       are bound to an object only so that we have access to them in
       the differently-scoped steps of the API bootstrapping
       process. At the end of the API setup process, this object gets
       removed.
    */
    util:{
      isInt32, isTypedArray, isBindableTypedArray, isSQLableTypedArray,
      affirmBindableTypedArray, typedArrayToString
    },
    
    /**
       Holds state which are specific to the WASM-related
       infrastructure and glue code. It is not expected that client
       code will normally need these, but they're exposed here in case
       it does. These APIs are _not_ to be considered an
       official/stable part of the sqlite3 WASM API. They may change
       as the developers' experience suggests appropriate changes.

       Note that a number of members of this object are injected
       dynamically after the api object is fully constructed, so
       not all are documented inline here.
    */
    wasm: {
    //^^^ TODO?: move wasm from sqlite3.capi.wasm to sqlite3.wasm
      /**
         Emscripten APIs have a deep-seated assumption that all pointers
         are 32 bits. We'll remain optimistic that that won't always be
         the case and will use this constant in places where we might
         otherwise use a hard-coded 4.
      */
      ptrSizeof: config.wasmPtrSizeof || 4,
      /**
         The WASM IR (Intermediate Representation) value for
         pointer-type values. It MUST refer to a value type of the
         size described by this.ptrSizeof _or_ it may be any value
         which ends in '*', which Emscripten's glue code internally
         translates to i32.
      */
      ptrIR: config.wasmPtrIR || "i32",
      /**
         True if BigInt support was enabled via (e.g.) the
         Emscripten -sWASM_BIGINT flag, else false. When
         enabled, certain 64-bit sqlite3 APIs are enabled which
         are not otherwise enabled due to JS/WASM int64
         impedence mismatches.
      */
      bigIntEnabled: !!config.bigIntEnabled,
      /**
         The symbols exported by the WASM environment.
      */
      exports: config.exports
        || toss("Missing API config.exports (WASM module exports)."),

      /**
         When Emscripten compiles with `-sIMPORT_MEMORY`, it
         initalizes the heap and imports it into wasm, as opposed to
         the other way around. In this case, the memory is not
         available via this.exports.memory.
      */
      memory: config.memory || config.exports['memory']
        || toss("API config object requires a WebAssembly.Memory object",
                "in either config.exports.memory (exported)",
                "or config.memory (imported)."),
      /* Many more wasm-related APIs get installed later on. */
    }/*wasm*/
  }/*capi*/;

  /**
     capi.wasm.alloc()'s srcTypedArray.byteLength bytes,
     populates them with the values from the source
     TypedArray, and returns the pointer to that memory. The
     returned pointer must eventually be passed to
     capi.wasm.dealloc() to clean it up.

     As a special case, to avoid further special cases where
     this is used, if srcTypedArray.byteLength is 0, it
     allocates a single byte and sets it to the value
     0. Even in such cases, calls must behave as if the
     allocated memory has exactly srcTypedArray.byteLength
     bytes.

     ACHTUNG: this currently only works for Uint8Array and
     Int8Array types and will throw if srcTypedArray is of
     any other type.
  */
  capi.wasm.mallocFromTypedArray = function(srcTypedArray){
    affirmBindableTypedArray(srcTypedArray);
    const pRet = this.alloc(srcTypedArray.byteLength || 1);
    this.heapForSize(srcTypedArray.constructor).set(srcTypedArray.byteLength ? srcTypedArray : [0], pRet);
    return pRet;
  }.bind(capi.wasm);

  const keyAlloc = config.allocExportName || 'malloc',
        keyDealloc =  config.deallocExportName || 'free';
  for(const key of [keyAlloc, keyDealloc]){
    const f = capi.wasm.exports[key];
    if(!(f instanceof Function)) toss("Missing required exports[",key,"] function.");
  }
  capi.wasm.alloc = function(n){
    const m = this.exports[keyAlloc](n);
    if(!m) throw new WasmAllocError("Failed to allocate "+n+" bytes.");
    return m;
  }.bind(capi.wasm)
  capi.wasm.dealloc = (m)=>capi.wasm.exports[keyDealloc](m);

  /**
     Reports info about compile-time options using
     sqlite_compileoption_get() and sqlite3_compileoption_used(). It
     has several distinct uses:

     If optName is an array then it is expected to be a list of
     compilation options and this function returns an object
     which maps each such option to true or false, indicating
     whether or not the given option was included in this
     build. That object is returned.

     If optName is an object, its keys are expected to be compilation
     options and this function sets each entry to true or false,
     indicating whether the compilation option was used or not. That
     object is returned.

     If passed no arguments then it returns an object mapping
     all known compilation options to their compile-time values,
     or boolean true if they are defined with no value. This
     result, which is relatively expensive to compute, is cached
     and returned for future no-argument calls.

     In all other cases it returns true if the given option was
     active when when compiling the sqlite3 module, else false.

     Compile-time option names may optionally include their
     "SQLITE_" prefix. When it returns an object of all options,
     the prefix is elided.
  */
  capi.wasm.compileOptionUsed = function f(optName){
    if(!arguments.length){
      if(f._result) return f._result;
      else if(!f._opt){
        f._rx = /^([^=]+)=(.+)/;
        f._rxInt = /^-?\d+$/;
        f._opt = function(opt, rv){
          const m = f._rx.exec(opt);
          rv[0] = (m ? m[1] : opt);
          rv[1] = m ? (f._rxInt.test(m[2]) ? +m[2] : m[2]) : true;
        };                    
      }
      const rc = {}, ov = [0,0];
      let i = 0, k;
      while((k = capi.sqlite3_compileoption_get(i++))){
        f._opt(k,ov);
        rc[ov[0]] = ov[1];
      }
      return f._result = rc;
    }else if(Array.isArray(optName)){
      const rc = {};
      optName.forEach((v)=>{
        rc[v] = capi.sqlite3_compileoption_used(v);
      });
      return rc;
    }else if('object' === typeof optName){
      Object.keys(optName).forEach((k)=> {
        optName[k] = capi.sqlite3_compileoption_used(k);
      });
      return optName;
    }
    return (
      'string'===typeof optName
    ) ? !!capi.sqlite3_compileoption_used(optName) : false;
  }/*compileOptionUsed()*/;

  capi.wasm.bindingSignatures = [
    /**
       Signatures for the WASM-exported C-side functions. Each entry
       is an array with 2+ elements:

       ["c-side name",
        "result type" (capi.wasm.xWrap() syntax),
         [arg types in xWrap() syntax]
         // ^^^ this needn't strictly be an array: it can be subsequent
         // elements instead: [x,y,z] is equivalent to x,y,z
       ]
    */
    // Please keep these sorted by function name!
    ["sqlite3_bind_blob","int", "sqlite3_stmt*", "int", "*", "int", "*"],
    ["sqlite3_bind_double","int", "sqlite3_stmt*", "int", "f64"],
    ["sqlite3_bind_int","int", "sqlite3_stmt*", "int", "int"],
    ["sqlite3_bind_null",undefined, "sqlite3_stmt*", "int"],
    ["sqlite3_bind_parameter_count", "int", "sqlite3_stmt*"],
    ["sqlite3_bind_parameter_index","int", "sqlite3_stmt*", "string"],
    ["sqlite3_bind_text","int", "sqlite3_stmt*", "int", "string", "int", "int"],
    ["sqlite3_close_v2", "int", "sqlite3*"],
    ["sqlite3_changes", "int", "sqlite3*"],
    ["sqlite3_clear_bindings","int", "sqlite3_stmt*"],
    ["sqlite3_column_blob","*", "sqlite3_stmt*", "int"],
    ["sqlite3_column_bytes","int", "sqlite3_stmt*", "int"],
    ["sqlite3_column_count", "int", "sqlite3_stmt*"],
    ["sqlite3_column_double","f64", "sqlite3_stmt*", "int"],
    ["sqlite3_column_int","int", "sqlite3_stmt*", "int"],
    ["sqlite3_column_name","string", "sqlite3_stmt*", "int"],
    ["sqlite3_column_text","string", "sqlite3_stmt*", "int"],
    ["sqlite3_column_type","int", "sqlite3_stmt*", "int"],
    ["sqlite3_compileoption_get", "string", "int"],
    ["sqlite3_compileoption_used", "int", "string"],
    ["sqlite3_create_function_v2", "int",
     "sqlite3*", "string", "int", "int", "*", "*", "*", "*", "*"],
    ["sqlite3_data_count", "int", "sqlite3_stmt*"],
    ["sqlite3_db_filename", "string", "sqlite3*", "string"],
    ["sqlite3_db_name", "string", "sqlite3*", "int"],
    ["sqlite3_errmsg", "string", "sqlite3*"],
    ["sqlite3_error_offset", "int", "sqlite3*"],
    ["sqlite3_errstr", "string", "int"],
    //["sqlite3_exec", "int", "sqlite3*", "string", "*", "*", "**"],
    // ^^^ TODO: we need a wrapper to support passing a function pointer or a function
    // for the callback.
    ["sqlite3_expanded_sql", "string", "sqlite3_stmt*"],
    ["sqlite3_extended_errcode", "int", "sqlite3*"],
    ["sqlite3_extended_result_codes", "int", "sqlite3*", "int"],
    ["sqlite3_finalize", "int", "sqlite3_stmt*"],
    ["sqlite3_initialize", undefined],
    ["sqlite3_interrupt", undefined, "sqlite3*"
     /* ^^^ we cannot actually currently support this because JS is
        single-threaded and we don't have a portable way to access a DB
        from 2 SharedWorkers concurrently. */],
    ["sqlite3_libversion", "string"],
    ["sqlite3_libversion_number", "int"],
    ["sqlite3_open", "int", "string", "*"],
    ["sqlite3_open_v2", "int", "string", "*", "int", "string"],
    /* sqlite3_prepare_v2() and sqlite3_prepare_v3() are handled
       separately due to us requiring two different sets of semantics
       for those, depending on how their SQL argument is provided. */
    ["sqlite3_reset", "int", "sqlite3_stmt*"],
    ["sqlite3_result_blob",undefined, "*", "*", "int", "*"],
    ["sqlite3_result_double",undefined, "*", "f64"],
    ["sqlite3_result_error",undefined, "*", "string", "int"],
    ["sqlite3_result_error_code", undefined, "*", "int"],
    ["sqlite3_result_error_nomem", undefined, "*"],
    ["sqlite3_result_error_toobig", undefined, "*"],
    ["sqlite3_result_int",undefined, "*", "int"],
    ["sqlite3_result_null",undefined, "*"],
    ["sqlite3_result_text",undefined, "*", "string", "int", "*"],
    ["sqlite3_sourceid", "string"],
    ["sqlite3_sql", "string", "sqlite3_stmt*"],
    ["sqlite3_step", "int", "sqlite3_stmt*"],
    ["sqlite3_strglob", "int", "string","string"],
    ["sqlite3_strlike", "int", "string","string","int"],
    ["sqlite3_total_changes", "int", "sqlite3*"],
    ["sqlite3_value_blob", "*", "*"],
    ["sqlite3_value_bytes","int", "*"],
    ["sqlite3_value_double","f64", "*"],
    ["sqlite3_value_text", "string", "*"],
    ["sqlite3_value_type", "int", "*"],
    ["sqlite3_vfs_find", "*", "string"],
    ["sqlite3_vfs_register", "int", "*", "int"]
  ]/*capi.wasm.bindingSignatures*/;

  if(false && capi.wasm.compileOptionUsed('SQLITE_ENABLE_NORMALIZE')){
    /* ^^^ "the problem" is that this is an option feature and the
       build-time function-export list does not currently take
       optional features into account. */
    capi.wasm.bindingSignatures.push(["sqlite3_normalized_sql", "string", "sqlite3_stmt*"]);
  }
  
  /**
     Functions which require BigInt (int64) support are separated from
     the others because we need to conditionally bind them or apply
     dummy impls, depending on the capabilities of the environment.
  */
  capi.wasm.bindingSignatures.int64 = [
      ["sqlite3_bind_int64","int", ["sqlite3_stmt*", "int", "i64"]],
      ["sqlite3_changes64","i64", ["sqlite3*"]],
      ["sqlite3_column_int64","i64", ["sqlite3_stmt*", "int"]],
      ["sqlite3_total_changes64", "i64", ["sqlite3*"]]
  ];

  /* The remainder of the API will be set up in later steps. */
  return {
    capi,
    postInit: [
      /* some pieces of the API may install functions into this array,
         and each such function will be called, passed (self,sqlite3),
         at the very end of the API load/init process, where self is
         the current global object and sqlite3 is the object returned
         from sqlite3ApiBootstrap(). This array will be removed at the
         end of the API setup process. */],
    /** Config is needed downstream for gluing pieces together. It
        will be removed at the end of the API setup process. */
    config
  };
}/*sqlite3ApiBootstrap()*/;
/* END FILE: api/sqlite3-api-prologue.js */
/* BEGIN FILE: common/whwasmutil.js */
/**
  2022-07-08

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  The whwasmutil is developed in conjunction with the Jaccwabyt
  project:

  https://fossil.wanderinghorse.net/r/jaccwabyt

  Maintenance reminder: If you're reading this in a tree other than
  the Jaccwabyt tree, note that this copy may be replaced with
  upstream copies of that one from time to time. Thus the code
  installed by this function "should not" be edited outside of that
  project, else it risks getting overwritten.
*/
/**
   This function is intended to simplify porting around various bits
   of WASM-related utility code from project to project.

   The primary goal of this code is to replace, where possible,
   Emscripten-generated glue code with equivalent utility code which
   can be used in arbitrary WASM environments built with toolchains
   other than Emscripten. As of this writing, this code is capable of
   acting as a replacement for Emscripten's generated glue code
   _except_ that the latter installs handlers for Emscripten-provided
   APIs such as its "FS" (virtual filesystem) API. Loading of such
   things still requires using Emscripten's glue, but the post-load
   utility APIs provided by this code are still usable as replacements
   for their sub-optimally-documented Emscripten counterparts.

   Intended usage:

   ```
   self.WhWasmUtilInstaller(appObject);
   delete self.WhWasmUtilInstaller;
   ```

   Its global-scope symbol is intended only to provide an easy way to
   make it available to 3rd-party scripts and "should" be deleted
   after calling it. That symbols is _not_ used within the library.

   Forewarning: this API explicitly targets only browser
   environments. If a given non-browser environment has the
   capabilities needed for a given feature (e.g. TextEncoder), great,
   but it does not go out of its way to account for them and does not
   provide compatibility crutches for them.

   It currently offers alternatives to the following
   Emscripten-generated APIs:

   - OPTIONALLY memory allocation, but how this gets imported is
     environment-specific.  Most of the following features only work
     if allocation is available.

   - WASM-exported "indirect function table" access and
     manipulation. e.g.  creating new WASM-side functions using JS
     functions, analog to Emscripten's addFunction() and
     removeFunction() but slightly different.

   - Get/set specific heap memory values, analog to Emscripten's
     getValue() and setValue().

   - String length counting in UTF-8 bytes (C-style and JS strings).

   - JS string to C-string conversion and vice versa, analog to
     Emscripten's stringToUTF8Array() and friends, but with slighter
     different interfaces.

   - JS string to Uint8Array conversion, noting that browsers actually
     already have this built in via TextEncoder.

   - "Scoped" allocation, such that allocations made inside of a given
     explicit scope will be automatically cleaned up when the scope is
     closed. This is fundamentally similar to Emscripten's
     stackAlloc() and friends but uses the heap instead of the stack
     because access to the stack requires C code.

   - Create JS wrappers for WASM functions, analog to Emscripten's
     ccall() and cwrap() functions, except that the automatic
     conversions for function arguments and return values can be
     easily customized by the client by assigning custom function
     signature type names to conversion functions. Essentially,
     it's ccall() and cwrap() on steroids.

   How to install...

   Passing an object to this function will install the functionality
   into that object. Afterwards, client code "should" delete the global
   symbol.

   This code requires that the target object have the following
   properties, noting that they needn't be available until the first
   time one of the installed APIs is used (as opposed to when this
   function is called) except where explicitly noted:

   - `exports` must be a property of the target object OR a property
     of `target.instance` (a WebAssembly.Module instance) and it must
     contain the symbols exported by the WASM module associated with
     this code. In an Enscripten environment it must be set to
     `Module['asm']`. The exports object must contain a minimum of the
     following symbols:

     - `memory`: a WebAssembly.Memory object representing the WASM
       memory. _Alternately_, the `memory` property can be set on the
       target instance, in particular if the WASM heap memory is
       initialized in JS an _imported_ into WASM, as opposed to being
       initialized in WASM and exported to JS.

     - `__indirect_function_table`: the WebAssembly.Table object which
       holds WASM-exported functions. This API does not strictly
       require that the table be able to grow but it will throw if its
       `installFunction()` is called and the table cannot grow.

   In order to simplify downstream usage, if `target.exports` is not
   set when this is called then a property access interceptor
   (read-only, configurable, enumerable) gets installed as `exports`
   which resolves to `target.instance.exports`, noting that the latter
   property need not exist until the first time `target.exports` is
   accessed.

   Some APIs _optionally_ make use of the `bigIntEnabled` property of
   the target object. It "should" be set to true if the WASM
   environment is compiled with BigInt support, else it must be
   false. If it is false, certain BigInt-related features will trigger
   an exception if invoked. This property, if not set when this is
   called, will get a default value of true only if the BigInt64Array
   constructor is available, else it will default to false.

   Some optional APIs require that the target have the following
   methods:

   - 'alloc()` must behave like C's `malloc()`, allocating N bytes of
     memory and returning its pointer. In Emscripten this is
     conventionally made available via `Module['_malloc']`. This API
     requires that the alloc routine throw on allocation error, as
     opposed to returning null or 0.

   - 'dealloc()` must behave like C's `free()`, accepting either a
     pointer returned from its allocation counterpart or the values
     null/0 (for which it must be a no-op). allocating N bytes of
     memory and returning its pointer. In Emscripten this is
     conventionally made available via `Module['_free']`.

   APIs which require allocation routines are explicitly documented as
   such and/or have "alloc" in their names.

   This code is developed and maintained in conjunction with the
   Jaccwabyt project:

   https://fossil.wanderinghorse.net/r/jaccwabbyt

   More specifically:

   https://fossil.wanderinghorse.net/r/jaccwabbyt/file/common/whwasmutil.js
*/
self.WhWasmUtilInstaller = function(target){
  'use strict';
  if(undefined===target.bigIntEnabled){
    target.bigIntEnabled = !!self['BigInt64Array'];
  }

  /** Throws a new Error, the message of which is the concatenation of
      all args with a space between each. */
  const toss = (...args)=>{throw new Error(args.join(' '))};

  if(!target.exports){
    Object.defineProperty(target, 'exports', {
      enumerable: true, configurable: true,
      get: ()=>(target.instance && target.instance.exports)
    });
  }

  /*********
    alloc()/dealloc() auto-install...

    This would be convenient but it can also cause us to pick up
    malloc() even when the client code is using a different exported
    allocator (who, me?), which is bad. malloc() may be exported even
    if we're not explicitly using it and overriding the malloc()
    function, linking ours first, is not always feasible when using a
    malloc() proxy, as it can lead to recursion and stack overflow
    (who, me?). So... we really need the downstream code to set up
    target.alloc/dealloc() itself.
  ******/
  /******
  if(target.exports){
    //Maybe auto-install alloc()/dealloc()...
    if(!target.alloc && target.exports.malloc){
      target.alloc = function(n){
        const m = this(n);
        return m || toss("Allocation of",n,"byte(s) failed.");
      }.bind(target.exports.malloc);
    }

    if(!target.dealloc && target.exports.free){
      target.dealloc = function(ptr){
        if(ptr) this(ptr);
      }.bind(target.exports.free);
    }
  }*******/

  /**
     Pointers in WASM are currently assumed to be 32-bit, but someday
     that will certainly change.
  */
  const ptrIR = target.pointerIR || 'i32';
  const ptrSizeof = ('i32'===ptrIR ? 4
                     : ('i64'===ptrIR
                        ? 8 : toss("Unhandled ptrSizeof:",ptrIR)));
  /** Stores various cached state. */
  const cache = Object.create(null);
  /** Previously-recorded size of cache.memory.buffer, noted so that
      we can recreate the view objects if the heap grows. */
  cache.heapSize = 0;
  /** WebAssembly.Memory object extracted from target.memory or
      target.exports.memory the first time heapWrappers() is
      called. */
  cache.memory = null;
  /** uninstallFunction() puts table indexes in here for reuse and
      installFunction() extracts them. */
  cache.freeFuncIndexes = [];
  /**
     Used by scopedAlloc() and friends.
  */
  cache.scopedAlloc = [];

  cache.utf8Decoder = new TextDecoder();
  cache.utf8Encoder = new TextEncoder('utf-8');

  /**
     If (cache.heapSize !== cache.memory.buffer.byteLength), i.e. if
     the heap has grown since the last call, updates cache.HEAPxyz.
     Returns the cache object.
  */
  const heapWrappers = function(){
    if(!cache.memory){
      cache.memory = (target.memory instanceof WebAssembly.Memory)
        ? target.memory : target.exports.memory;
    }else if(cache.heapSize === cache.memory.buffer.byteLength){
      return cache;
    }
    // heap is newly-acquired or has been resized....
    const b = cache.memory.buffer;
    cache.HEAP8 = new Int8Array(b); cache.HEAP8U = new Uint8Array(b);
    cache.HEAP16 = new Int16Array(b); cache.HEAP16U = new Uint16Array(b);
    cache.HEAP32 = new Int32Array(b); cache.HEAP32U = new Uint32Array(b);
    if(target.bigIntEnabled){
      cache.HEAP64 = new BigInt64Array(b); cache.HEAP64U = new BigUint64Array(b);
    }
    cache.HEAP32F = new Float32Array(b); cache.HEAP64F = new Float64Array(b);
    cache.heapSize = b.byteLength;
    return cache;
  };

  /** Convenience equivalent of this.heapForSize(8,false). */
  target.heap8 = ()=>heapWrappers().HEAP8;

  /** Convenience equivalent of this.heapForSize(8,true). */
  target.heap8u = ()=>heapWrappers().HEAP8U;

  /** Convenience equivalent of this.heapForSize(16,false). */
  target.heap16 = ()=>heapWrappers().HEAP16;

  /** Convenience equivalent of this.heapForSize(16,true). */
  target.heap16u = ()=>heapWrappers().HEAP16U;

  /** Convenience equivalent of this.heapForSize(32,false). */
  target.heap32 = ()=>heapWrappers().HEAP32;

  /** Convenience equivalent of this.heapForSize(32,true). */
  target.heap32u = ()=>heapWrappers().HEAP32U;

  /**
     Requires n to be one of:

     - integer 8, 16, or 32.
     - A integer-type TypedArray constructor: Int8Array, Int16Array,
     Int32Array, or their Uint counterparts.

     If this.bigIntEnabled is true, it also accepts the value 64 or a
     BigInt64Array/BigUint64Array, else it throws if passed 64 or one
     of those constructors.

     Returns an integer-based TypedArray view of the WASM heap
     memory buffer associated with the given block size. If passed
     an integer as the first argument and unsigned is truthy then
     the "U" (unsigned) variant of that view is returned, else the
     signed variant is returned. If passed a TypedArray value, the
     2nd argument is ignores. Note that Float32Array and
     Float64Array views are not supported by this function.

     Note that growth of the heap will invalidate any references to
     this heap, so do not hold a reference longer than needed and do
     not use a reference after any operation which may
     allocate. Instead, re-fetch the reference by calling this
     function again.

     Throws if passed an invalid n.

     Pedantic side note: the name "heap" is a bit of a misnomer. In an
     Emscripten environment, the memory managed via the stack
     allocation API is in the same Memory object as the heap (which
     makes sense because otherwise arbitrary pointer X would be
     ambiguous: is it in the heap or the stack?).
  */
  target.heapForSize = function(n,unsigned = false){
    let ctor;
    const c = (cache.memory && cache.heapSize === cache.memory.buffer.byteLength)
          ? cache : heapWrappers();
    switch(n){
        case Int8Array: return c.HEAP8; case Uint8Array: return c.HEAP8U;
        case Int16Array: return c.HEAP16; case Uint16Array: return c.HEAP16U;
        case Int32Array: return c.HEAP32; case Uint32Array: return c.HEAP32U;
        case 8:  return unsigned ? c.HEAP8U : c.HEAP8;
        case 16: return unsigned ? c.HEAP16U : c.HEAP16;
        case 32: return unsigned ? c.HEAP32U : c.HEAP32;
        case 64:
          if(c.HEAP64) return unsigned ? c.HEAP64U : c.HEAP64;
          break;
        default:
          if(this.bigIntEnabled){
            if(n===self['BigUint64Array']) return c.HEAP64U;
            else if(n===self['BigInt64Array']) return c.HEAP64;
            break;
          }
    }
    toss("Invalid heapForSize() size: expecting 8, 16, 32,",
         "or (if BigInt is enabled) 64.");
  }.bind(target);

  /**
     Returns the WASM-exported "indirect function table."
  */
  target.functionTable = function(){
    return target.exports.__indirect_function_table;
    /** -----------------^^^^^ "seems" to be a standardized export name.
        From Emscripten release notes from 2020-09-10:
        - Use `__indirect_function_table` as the import name for the
        table, which is what LLVM does.
    */
  }.bind(target);

  /**
     Given a function pointer, returns the WASM function table entry
     if found, else returns a falsy value.
  */
  target.functionEntry = function(fptr){
    const ft = this.functionTable();
    return fptr < ft.length ? ft.get(fptr) : undefined;
  }.bind(target);

  /**
     Creates a WASM function which wraps the given JS function and
     returns the JS binding of that WASM function. The signature
     argument must be the Jaccwabyt-format or Emscripten
     addFunction()-format function signature string. In short: in may
     have one of the following formats:

     - Emscripten: `x...`, where the first x is a letter representing
       the result type and subsequent letters represent the argument
       types. See below.

     - Jaccwabyt: `x(...)` where `x` is the letter representing the
       result type and letters in the parens (if any) represent the
       argument types. See below.

     Supported letters:

     - `i` = int32
     - `p` = int32 ("pointer")
     - `j` = int64
     - `f` = float32
     - `d` = float64
     - `v` = void, only legal for use as the result type

     It throws if an invalid signature letter is used.

     Jaccwabyt-format signatures support some additional letters which
     have no special meaning here but (in this context) act as aliases
     for other letters:

     - `s`, `P`: same as `p`

     Sidebar: this code is developed together with Jaccwabyt, thus the
     support for its signature format.
  */
  target.jsFuncToWasm = function f(func, sig){
    /** Attribution: adapted up from Emscripten-generated glue code,
        refactored primarily for efficiency's sake, eliminating
        call-local functions and superfluous temporary arrays. */
    if(!f._){/*static init...*/
      f._ = {
        // Map of signature letters to type IR values
        sigTypes: Object.create(null),
        // Map of type IR values to WASM type code values
        typeCodes: Object.create(null),
        /** Encodes n, which must be <2^14 (16384), into target array
            tgt, as a little-endian value, using the given method
            ('push' or 'unshift'). */
        uleb128Encode: function(tgt, method, n){
          if(n<128) tgt[method](n);
          else tgt[method]( (n % 128) | 128, n>>7);
        },
        /** Intentionally-lax pattern for Jaccwabyt-format function
            pointer signatures, the intent of which is simply to
            distinguish them from Emscripten-format signatures. The
            downstream checks are less lax. */
        rxJSig: /^(\w)\((\w*)\)$/,
        /** Returns the parameter-value part of the given signature
            string. */
        sigParams: function(sig){
          const m = f._.rxJSig.exec(sig);
          return m ? m[2] : sig.substr(1);
        },
        /** Returns the IR value for the given letter or throws
            if the letter is invalid. */
        letterType: (x)=>f._.sigTypes[x] || toss("Invalid signature letter:",x),
        /** Returns an object describing the result type and parameter
            type(s) of the given function signature, or throws if the
            signature is invalid. */
        /******** // only valid for use with the WebAssembly.Function ctor, which
                  // is not yet documented on MDN. 
        sigToWasm: function(sig){
          const rc = {parameters:[], results: []};
          if('v'!==sig[0]) rc.results.push(f._.letterType(sig[0]));
          for(const x of f._.sigParams(sig)){
            rc.parameters.push(f._.letterType(x));
          }
          return rc;
        },************/
        /** Pushes the WASM data type code for the given signature
            letter to the given target array. Throws if letter is
            invalid. */
        pushSigType: (dest, letter)=>dest.push(f._.typeCodes[f._.letterType(letter)])
      };
      f._.sigTypes.i = f._.sigTypes.p = f._.sigTypes.P = f._.sigTypes.s = 'i32';
      f._.sigTypes.j = 'i64'; f._.sigTypes.f = 'f32'; f._.sigTypes.d = 'f64';
      f._.typeCodes['i32'] = 0x7f; f._.typeCodes['i64'] = 0x7e;
      f._.typeCodes['f32'] = 0x7d; f._.typeCodes['f64'] = 0x7c;
    }/*static init*/
    const sigParams = f._.sigParams(sig);
    const wasmCode = [0x01/*count: 1*/, 0x60/*function*/];
    f._.uleb128Encode(wasmCode, 'push', sigParams.length);
    for(const x of sigParams) f._.pushSigType(wasmCode, x);
    if('v'===sig[0]) wasmCode.push(0);
    else{
      wasmCode.push(1);
      f._.pushSigType(wasmCode, sig[0]);
    }
    f._.uleb128Encode(wasmCode, 'unshift', wasmCode.length)/* type section length */;
    wasmCode.unshift(
      0x00, 0x61, 0x73, 0x6d, /* magic: "\0asm" */
      0x01, 0x00, 0x00, 0x00, /* version: 1 */
      0x01 /* type section code */
    );
    wasmCode.push(
      /* import section: */ 0x02, 0x07,
      /* (import "e" "f" (func 0 (type 0))): */
      0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
      /* export section: */ 0x07, 0x05,
      /* (export "f" (func 0 (type 0))): */
      0x01, 0x01, 0x66, 0x00, 0x00
    );
    return (new WebAssembly.Instance(
      new WebAssembly.Module(new Uint8Array(wasmCode)), {
        e: { f: func }
      })).exports['f'];
  }/*jsFuncToWasm()*/;
  
  /**
     Expects a JS function and signature, exactly as for
     this.jsFuncToWasm(). It uses that function to create a
     WASM-exported function, installs that function to the next
     available slot of this.functionTable(), and returns the
     function's index in that table (which acts as a pointer to that
     function). The returned pointer can be passed to
     removeFunction() to uninstall it and free up the table slot for
     reuse.

     As a special case, if the passed-in function is a WASM-exported
     function then the signature argument is ignored and func is
     installed as-is, without requiring re-compilation/re-wrapping.

     This function will propagate an exception if
     WebAssembly.Table.grow() throws or this.jsFuncToWasm() throws.
     The former case can happen in an Emscripten-compiled
     environment when building without Emscripten's
     `-sALLOW_TABLE_GROWTH` flag.

     Sidebar: this function differs from Emscripten's addFunction()
     _primarily_ in that it does not share that function's
     undocumented behavior of reusing a function if it's passed to
     addFunction() more than once, which leads to removeFunction()
     breaking clients which do not take care to avoid that case:

     https://github.com/emscripten-core/emscripten/issues/17323
  */
  target.installFunction = function f(func, sig){
    const ft = this.functionTable();
    const oldLen = ft.length;
    let ptr;
    while(cache.freeFuncIndexes.length){
      ptr = cache.freeFuncIndexes.pop();
      if(ft.get(ptr)){ /* Table was modified via a different API */
        ptr = null;
        continue;
      }else{
        break;
      }
    }
    if(!ptr){
      ptr = oldLen;
      ft.grow(1);
    }
    try{
      /*this will only work if func is a WASM-exported function*/
      ft.set(ptr, func);
      return ptr;
    }catch(e){
      if(!(e instanceof TypeError)){
        if(ptr===oldLen) cache.freeFuncIndexes.push(oldLen);
        throw e;
      }
    }
    // It's not a WASM-exported function, so compile one...
    try {
      ft.set(ptr, this.jsFuncToWasm(func, sig));
    }catch(e){
      if(ptr===oldLen) cache.freeFuncIndexes.push(oldLen);
      throw e;
    }
    return ptr;      
  }.bind(target);

  /**
     Requires a pointer value previously returned from
     this.installFunction(). Removes that function from the WASM
     function table, marks its table slot as free for re-use, and
     returns that function. It is illegal to call this before
     installFunction() has been called and results are undefined if
     ptr was not returned by that function. The returned function
     may be passed back to installFunction() to reinstall it.
  */
  target.uninstallFunction = function(ptr){
    const fi = cache.freeFuncIndexes;
    const ft = this.functionTable();
    fi.push(ptr);
    const rc = ft.get(ptr);
    ft.set(ptr, null);
    return rc;
  }.bind(target);

  /**
     Given a WASM heap memory address and a data type name in the form
     (i8, i16, i32, i64, float (or f32), double (or f64)), this
     fetches the numeric value from that address and returns it as a
     number or, for the case of type='i64', a BigInt (noting that that
     type triggers an exception if this.bigIntEnabled is
     falsy). Throws if given an invalid type.

     As a special case, if type ends with a `*`, it is considered to
     be a pointer type and is treated as the WASM numeric type
     appropriate for the pointer size (`i32`).

     While likely not obvious, this routine and its setMemValue()
     counterpart are how pointer-to-value _output_ parameters
     in WASM-compiled C code can be interacted with:

     ```
     const ptr = alloc(4);
     setMemValue(ptr, 0, 'i32'); // clear the ptr's value
     aCFuncWithOutputPtrToInt32Arg( ptr ); // e.g. void foo(int *x);
     const result = getMemValue(ptr, 'i32'); // fetch ptr's value
     dealloc(ptr);
     ```

     scopedAlloc() and friends can be used to make handling of
     `ptr` safe against leaks in the case of an exception:

     ```
     let result;
     const scope = scopedAllocPush();
     try{
       const ptr = scopedAlloc(4);
       setMemValue(ptr, 0, 'i32');
       aCFuncWithOutputPtrArg( ptr );
       result = getMemValue(ptr, 'i32');
     }finally{
       scopedAllocPop(scope);
     }
     ```

     As a rule setMemValue() must be called to set (typically zero
     out) the pointer's value, else it will contain an essentially
     random value.

     See: setMemValue()
  */
  target.getMemValue = function(ptr, type='i8'){
    if(type.endsWith('*')) type = ptrIR;
    const c = (cache.memory && cache.heapSize === cache.memory.buffer.byteLength)
          ? cache : heapWrappers();
    switch(type){
        case 'i1':
        case 'i8': return c.HEAP8[ptr>>0];
        case 'i16': return c.HEAP16[ptr>>1];
        case 'i32': return c.HEAP32[ptr>>2];
        case 'i64':
          if(this.bigIntEnabled) return BigInt(c.HEAP64[ptr>>3]);
          break;
        case 'float': case 'f32': return c.HEAP32F[ptr>>2];
        case 'double': case 'f64': return Number(c.HEAP64F[ptr>>3]);
        default: break;
    }
    toss('Invalid type for getMemValue():',type);
  }.bind(target);

  /**
     The counterpart of getMemValue(), this sets a numeric value at
     the given WASM heap address, using the type to define how many
     bytes are written. Throws if given an invalid type. See
     getMemValue() for details about the type argument. If the 3rd
     argument ends with `*` then it is treated as a pointer type and
     this function behaves as if the 3rd argument were `i32`.

     This function returns itself.
  */
  target.setMemValue = function f(ptr, value, type='i8'){
    if (type.endsWith('*')) type = ptrIR;
    const c = (cache.memory && cache.heapSize === cache.memory.buffer.byteLength)
          ? cache : heapWrappers();
    switch (type) {
        case 'i1': 
        case 'i8': c.HEAP8[ptr>>0] = value; return f;
        case 'i16': c.HEAP16[ptr>>1] = value; return f;
        case 'i32': c.HEAP32[ptr>>2] = value; return f;
        case 'i64':
          if(c.HEAP64){
            c.HEAP64[ptr>>3] = BigInt(value);
            return f;
          }
          break;
        case 'float': case 'f32': c.HEAP32F[ptr>>2] = value; return f;
        case 'double': case 'f64': c.HEAP64F[ptr>>3] = value; return f;
    }
    toss('Invalid type for setMemValue(): ' + type);
  };

  /**
     Expects ptr to be a pointer into the WASM heap memory which
     refers to a NUL-terminated C-style string encoded as UTF-8.
     Returns the length, in bytes, of the string, as for `strlen(3)`.
     As a special case, if !ptr then it it returns `null`. Throws if
     ptr is out of range for target.heap8u().
  */
  target.cstrlen = function(ptr){
    if(!ptr) return null;
    const h = heapWrappers().HEAP8U;
    let pos = ptr;
    for( ; h[pos] !== 0; ++pos ){}
    return pos - ptr;
  };

  /**
     Expects ptr to be a pointer into the WASM heap memory which
     refers to a NUL-terminated C-style string encoded as UTF-8. This
     function counts its byte length using cstrlen() then returns a
     JS-format string representing its contents. As a special case, if
     ptr is falsy, `null` is returned.
  */
  target.cstringToJs = function(ptr){
    const n = this.cstrlen(ptr);
    if(null===n) return n;
    return n
      ? cache.utf8Decoder.decode(
        new Uint8Array(heapWrappers().HEAP8U.buffer, ptr, n)
      ) : "";
  }.bind(target);

  /**
     Given a JS string, this function returns its UTF-8 length in
     bytes. Returns null if str is not a string.
  */
  target.jstrlen = function(str){
    /** Attribution: derived from Emscripten's lengthBytesUTF8() */
    if('string'!==typeof str) return null;
    const n = str.length;
    let len = 0;
    for(let i = 0; i < n; ++i){
      let u = str.charCodeAt(i);
      if(u>=0xd800 && u<=0xdfff){
        u = 0x10000 + ((u & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF);
      }
      if(u<=0x7f) ++len;
      else if(u<=0x7ff) len += 2;
      else if(u<=0xffff) len += 3;
      else len += 4;
    }
    return len;
  };

  /**
     Encodes the given JS string as UTF8 into the given TypedArray
     tgt, starting at the given offset and writing, at most, maxBytes
     bytes (including the NUL terminator if addNul is true, else no
     NUL is added). If it writes any bytes at all and addNul is true,
     it always NUL-terminates the output, even if doing so means that
     the NUL byte is all that it writes.

     If maxBytes is negative (the default) then it is treated as the
     remaining length of tgt, starting at the given offset.

     If writing the last character would surpass the maxBytes count
     because the character is multi-byte, that character will not be
     written (as opposed to writing a truncated multi-byte character).
     This can lead to it writing as many as 3 fewer bytes than
     maxBytes specifies.

     Returns the number of bytes written to the target, _including_
     the NUL terminator (if any). If it returns 0, it wrote nothing at
     all, which can happen if:

     - str is empty and addNul is false.
     - offset < 0.
     - maxBytes == 0.
     - maxBytes is less than the byte length of a multi-byte str[0].

     Throws if tgt is not an Int8Array or Uint8Array.

     Design notes:

     - In C's strcpy(), the destination pointer is the first
       argument. That is not the case here primarily because the 3rd+
       arguments are all referring to the destination, so it seems to
       make sense to have them grouped with it.

     - Emscripten's counterpart of this function (stringToUTF8Array())
       returns the number of bytes written sans NUL terminator. That
       is, however, ambiguous: str.length===0 or maxBytes===(0 or 1)
       all cause 0 to be returned.
  */
  target.jstrcpy = function(jstr, tgt, offset = 0, maxBytes = -1, addNul = true){
    /** Attribution: the encoding bits are taken from Emscripten's
        stringToUTF8Array(). */
    if(!tgt || (!(tgt instanceof Int8Array) && !(tgt instanceof Uint8Array))){
      toss("jstrcpy() target must be an Int8Array or Uint8Array.");
    }
    if(maxBytes<0) maxBytes = tgt.length - offset;
    if(!(maxBytes>0) || !(offset>=0)) return 0;
    let i = 0, max = jstr.length;
    const begin = offset, end = offset + maxBytes - (addNul ? 1 : 0);
    for(; i < max && offset < end; ++i){
      let u = jstr.charCodeAt(i);
      if(u>=0xd800 && u<=0xdfff){
        u = 0x10000 + ((u & 0x3FF) << 10) | (jstr.charCodeAt(++i) & 0x3FF);
      }
      if(u<=0x7f){
        if(offset >= end) break;
        tgt[offset++] = u;
      }else if(u<=0x7ff){
        if(offset + 1 >= end) break;
        tgt[offset++] = 0xC0 | (u >> 6);
        tgt[offset++] = 0x80 | (u & 0x3f);
      }else if(u<=0xffff){
        if(offset + 2 >= end) break;
        tgt[offset++] = 0xe0 | (u >> 12);
        tgt[offset++] = 0x80 | ((u >> 6) & 0x3f);
        tgt[offset++] = 0x80 | (u & 0x3f);
      }else{
        if(offset + 3 >= end) break;
        tgt[offset++] = 0xf0 | (u >> 18);
        tgt[offset++] = 0x80 | ((u >> 12) & 0x3f);
        tgt[offset++] = 0x80 | ((u >> 6) & 0x3f);
        tgt[offset++] = 0x80 | (u & 0x3f);
      }
    }
    if(addNul) tgt[offset++] = 0;
    return offset - begin;
  };

  /**
     Works similarly to C's strncpy(), copying, at most, n bytes (not
     characters) from srcPtr to tgtPtr. It copies until n bytes have
     been copied or a 0 byte is reached in src. _Unlike_ strncpy(), it
     returns the number of bytes it assigns in tgtPtr, _including_ the
     NUL byte (if any). If n is reached before a NUL byte in srcPtr,
     tgtPtr will _not_ be NULL-terminated. If a NUL byte is reached
     before n bytes are copied, tgtPtr will be NUL-terminated.

     If n is negative, cstrlen(srcPtr)+1 is used to calculate it, the
     +1 being for the NUL byte.

     Throws if tgtPtr or srcPtr are falsy. Results are undefined if:

     - either is not a pointer into the WASM heap or

     - srcPtr is not NUL-terminated AND n is less than srcPtr's
       logical length.

     ACHTUNG: it is possible to copy partial multi-byte characters
     this way, and converting such strings back to JS strings will
     have undefined results.
  */
  target.cstrncpy = function(tgtPtr, srcPtr, n){
    if(!tgtPtr || !srcPtr) toss("cstrncpy() does not accept NULL strings.");
    if(n<0) n = this.cstrlen(strPtr)+1;
    else if(!(n>0)) return 0;
    const heap = this.heap8u();
    let i = 0, ch;
    for(; i < n && (ch = heap[srcPtr+i]); ++i){
      heap[tgtPtr+i] = ch;
    }
    if(i<n) heap[tgtPtr + i++] = 0;
    return i;
  }.bind(target);

  /**
     For the given JS string, returns a Uint8Array of its contents
     encoded as UTF-8. If addNul is true, the returned array will have
     a trailing 0 entry, else it will not.
  */
  target.jstrToUintArray = (str, addNul=false)=>{
    return cache.utf8Encoder.encode(addNul ? (str+"\0") : str);
    // Or the hard way...
    /** Attribution: derived from Emscripten's stringToUTF8Array() */
    //const a = [], max = str.length;
    //let i = 0, pos = 0;
    //for(; i < max; ++i){
    //  let u = str.charCodeAt(i);
    //  if(u>=0xd800 && u<=0xdfff){
    //    u = 0x10000 + ((u & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF);
    //  }
    //  if(u<=0x7f) a[pos++] = u;
    //  else if(u<=0x7ff){
    //    a[pos++] = 0xC0 | (u >> 6);
    //    a[pos++] = 0x80 | (u & 63);
    //  }else if(u<=0xffff){
    //    a[pos++] = 0xe0 | (u >> 12);
    //    a[pos++] = 0x80 | ((u >> 6) & 63);
    //    a[pos++] = 0x80 | (u & 63);
    //  }else{
    //    a[pos++] = 0xf0 | (u >> 18);
    //    a[pos++] = 0x80 | ((u >> 12) & 63);
    //    a[pos++] = 0x80 | ((u >> 6) & 63);
    //    a[pos++] = 0x80 | (u & 63);
    //  }
    // }
    // return new Uint8Array(a);
  };

  const __affirmAlloc = (obj,funcName)=>{
    if(!(obj.alloc instanceof Function) ||
       !(obj.dealloc instanceof Function)){
      toss("Object is missing alloc() and/or dealloc() function(s)",
           "required by",funcName+"().");
    }
  };

  const __allocCStr = function(jstr, returnWithLength, allocator, funcName){
    __affirmAlloc(this, funcName);
    if('string'!==typeof jstr) return null;
    const n = this.jstrlen(jstr),
          ptr = allocator(n+1);
    this.jstrcpy(jstr, this.heap8u(), ptr, n+1, true);
    return returnWithLength ? [ptr, n] : ptr;
  }.bind(target);

  /**
     Uses target.alloc() to allocate enough memory for jstrlen(jstr)+1
     bytes of memory, copies jstr to that memory using jstrcpy(),
     NUL-terminates it, and returns the pointer to that C-string.
     Ownership of the pointer is transfered to the caller, who must
     eventually pass the pointer to dealloc() to free it.

     If passed a truthy 2nd argument then its return semantics change:
     it returns [ptr,n], where ptr is the C-string's pointer and n is
     its cstrlen().

     Throws if `target.alloc` or `target.dealloc` are not functions.
  */
  target.allocCString =
    (jstr, returnWithLength=false)=>__allocCStr(jstr, returnWithLength,
                                                target.alloc, 'allocCString()');

  /**
     Starts an "allocation scope." All allocations made using
     scopedAlloc() are recorded in this scope and are freed when the
     value returned from this function is passed to
     scopedAllocPop().

     This family of functions requires that the API's object have both
     `alloc()` and `dealloc()` methods, else this function will throw.

     Intended usage:

     ```
     const scope = scopedAllocPush();
     try {
       const ptr1 = scopedAlloc(100);
       const ptr2 = scopedAlloc(200);
       const ptr3 = scopedAlloc(300);
       ...
       // Note that only allocations made via scopedAlloc()
       // are managed by this allocation scope.
     }finally{
       scopedAllocPop(scope);
     }
     ```

     The value returned by this function must be treated as opaque by
     the caller, suitable _only_ for passing to scopedAllocPop().
     Its type and value are not part of this function's API and may
     change in any given version of this code.

     `scopedAlloc.level` can be used to determine how many scoped
     alloc levels are currently active.
   */
  target.scopedAllocPush = function(){
    __affirmAlloc(this, 'scopedAllocPush');
    const a = [];
    cache.scopedAlloc.push(a);
    return a;
  }.bind(target);

  /**
     Cleans up all allocations made using scopedAlloc() in the context
     of the given opaque state object, which must be a value returned
     by scopedAllocPush(). See that function for an example of how to
     use this function.

     Though scoped allocations are managed like a stack, this API
     behaves properly if allocation scopes are popped in an order
     other than the order they were pushed.

     If called with no arguments, it pops the most recent
     scopedAllocPush() result:

     ```
     scopedAllocPush();
     try{ ... } finally { scopedAllocPop(); }
     ```

     It's generally recommended that it be passed an explicit argument
     to help ensure that push/push are used in matching pairs, but in
     trivial code that may be a non-issue.
  */
  target.scopedAllocPop = function(state){
    __affirmAlloc(this, 'scopedAllocPop');
    const n = arguments.length
          ? cache.scopedAlloc.indexOf(state)
          : cache.scopedAlloc.length-1;
    if(n<0) toss("Invalid state object for scopedAllocPop().");
    if(0===arguments.length) state = cache.scopedAlloc[n];
    cache.scopedAlloc.splice(n,1);
    for(let p; (p = state.pop()); ) this.dealloc(p);
  }.bind(target);

  /**
     Allocates n bytes of memory using this.alloc() and records that
     fact in the state for the most recent call of scopedAllocPush().
     Ownership of the memory is given to scopedAllocPop(), which
     will clean it up when it is called. The memory _must not_ be
     passed to this.dealloc(). Throws if this API object is missing
     the required `alloc()` or `dealloc()` functions or no scoped
     alloc is active.

     See scopedAllocPush() for an example of how to use this function.

     The `level` property of this function can be queried to query how
     many scoped allocation levels are currently active.

     See also: scopedAllocPtr(), scopedAllocCString()
  */
  target.scopedAlloc = function(n){
    if(!cache.scopedAlloc.length){
      toss("No scopedAllocPush() scope is active.");
    }
    const p = this.alloc(n);
    cache.scopedAlloc[cache.scopedAlloc.length-1].push(p);
    return p;
  }.bind(target);

  Object.defineProperty(target.scopedAlloc, 'level', {
    configurable: false, enumerable: false,
    get: ()=>cache.scopedAlloc.length,
    set: ()=>toss("The 'active' property is read-only.")
  });

  /**
     Works identically to allocCString() except that it allocates the
     memory using scopedAlloc().

     Will throw if no scopedAllocPush() call is active.
  */
  target.scopedAllocCString =
    (jstr, returnWithLength=false)=>__allocCStr(jstr, returnWithLength,
                                                target.scopedAlloc, 'scopedAllocCString()');

  /**
     Wraps function call func() in a scopedAllocPush() and
     scopedAllocPop() block, such that all calls to scopedAlloc() and
     friends from within that call will have their memory freed
     automatically when func() returns. If func throws or propagates
     an exception, the scope is still popped, otherwise it returns the
     result of calling func().
  */
  target.scopedAllocCall = function(func){
    this.scopedAllocPush();
    try{ return func() } finally{ this.scopedAllocPop() }
  }.bind(target);

  /** Internal impl for allocPtr() and scopedAllocPtr(). */
  const __allocPtr = function(howMany, method){
    __affirmAlloc(this, method);
    let m = this[method](howMany * ptrSizeof);
    this.setMemValue(m, 0, ptrIR)
    if(1===howMany){
      return m;
    }
    const a = [m];
    for(let i = 1; i < howMany; ++i){
      m += ptrSizeof;
      a[i] = m;
      this.setMemValue(m, 0, ptrIR);
    }
    return a;
  }.bind(target);  

  /**
     Allocates a single chunk of memory capable of holding `howMany`
     pointers and zeroes them out. If `howMany` is 1 then the memory
     chunk is returned directly, else an array of pointer addresses is
     returned, which can optionally be used with "destructuring
     assignment" like this:

     ```
     const [p1, p2, p3] = allocPtr(3);
     ```

     ACHTUNG: when freeing the memory, pass only the _first_ result
     value to dealloc(). The others are part of the same memory chunk
     and must not be freed separately.
  */
  target.allocPtr = (howMany=1)=>__allocPtr(howMany, 'alloc');

  /**
     Identical to allocPtr() except that it allocates using scopedAlloc()
     instead of alloc().
  */
  target.scopedAllocPtr = (howMany=1)=>__allocPtr(howMany, 'scopedAlloc');

  /**
     If target.exports[name] exists, it is returned, else an
     exception is thrown.
  */
  target.xGet = function(name){
    return target.exports[name] || toss("Cannot find exported symbol:",name);
  };

  const __argcMismatch =
        (f,n)=>toss(f+"() requires",n,"argument(s).");
  
  /**
     Looks up a WASM-exported function named fname from
     target.exports.  If found, it is called, passed all remaining
     arguments, and its return value is returned to xCall's caller. If
     not found, an exception is thrown. This function does no
     conversion of argument or return types, but see xWrap()
     and xCallWrapped() for variants which do.

     As a special case, if passed only 1 argument after the name and
     that argument in an Array, that array's entries become the
     function arguments. (This is not an ambiguous case because it's
     not legal to pass an Array object to a WASM function.)
  */
  target.xCall = function(fname, ...args){
    const f = this.xGet(fname);
    if(!(f instanceof Function)) toss("Exported symbol",fname,"is not a function.");
    if(f.length!==args.length) __argcMismatch(fname,f.length)
    /* This is arguably over-pedantic but we want to help clients keep
       from shooting themselves in the foot when calling C APIs. */;
    return (2===arguments.length && Array.isArray(arguments[1]))
      ? f.apply(null, arguments[1])
      : f.apply(null, args);
  }.bind(target);

  /**
     State for use with xWrap()
  */
  cache.xWrap = Object.create(null);
  const xcv = cache.xWrap.convert = Object.create(null);
  /** Map of type names to argument conversion functions. */
  cache.xWrap.convert.arg = Object.create(null);
  /** Map of type names to return result conversion functions. */
  cache.xWrap.convert.result = Object.create(null);

  xcv.arg.i64 = (i)=>BigInt(i);
  xcv.arg.i32 = (i)=>(i | 0);
  xcv.arg.i16 = (i)=>((i | 0) & 0xFFFF);
  xcv.arg.i8  = (i)=>((i | 0) & 0xFF);
  xcv.arg.f32 = xcv.arg.float = (i)=>Number(i).valueOf();
  xcv.arg.f64 = xcv.arg.double = xcv.arg.f32;
  xcv.arg.int = xcv.arg.i32;
  xcv.result['*'] = xcv.result['pointer'] = xcv.arg[ptrIR];

  for(const t of ['i8', 'i16', 'i32', 'int', 'i64',
                  'f32', 'float', 'f64', 'double']){
    xcv.arg[t+'*'] = xcv.result[t+'*'] = xcv.arg[ptrIR]
    xcv.result[t] = xcv.arg[t] || toss("Missing arg converter:",t);
  }
  xcv.arg['**'] = xcv.arg[ptrIR];

  /**
     In order for args of type string to work in various contexts in
     the sqlite3 API, we need to pass them on as, variably, a C-string
     or a pointer value. Thus for ARGs of type 'string' and
     '*'/'pointer' we behave differently depending on whether the
     argument is a string or not:

     - If v is a string, scopeAlloc() a new C-string from it and return
       that temp string's pointer.

     - Else return the value from the arg adaptor defined for ptrIR.

     TODO? Permit an Int8Array/Uint8Array and convert it to a string?
     Would that be too much magic concentrated in one place, ready to
     backfire?
  */
  xcv.arg.string = xcv.arg['pointer'] = xcv.arg['*'] = function(v){
    if('string'===typeof v) return target.scopedAllocCString(v);
    return v ? xcv.arg[ptrIR](v) : null;
  };
  xcv.result.string = (i)=>target.cstringToJs(i);
  xcv.result['string:free'] = function(i){
    try { return i ? target.cstringToJs(i) : null }
    finally{ target.dealloc(i) }
  };
  xcv.result.json = (i)=>JSON.parse(target.cstringToJs(i));
  xcv.result['json:free'] = function(i){
    try{ return i ? JSON.parse(target.cstringToJs(i)) : null }
    finally{ target.dealloc(i) }
  }
  xcv.result['void'] = (v)=>undefined;
  xcv.result['null'] = (v)=>v;

  if(0){
    /***
        This idea can't currently work because we don't know the
        signature for the func and don't have a way for the user to
        convey it. To do this we likely need to be able to match
        arg/result handlers by a regex, but that would incur an O(N)
        cost as we check the regex one at a time. Another use case for
        such a thing would be pseudotypes like "int:-1" to say that
        the value will always be treated like -1 (which has a useful
        case in the sqlite3 bindings).
    */
    xcv.arg['func-ptr'] = function(v){
      if(!(v instanceof Function)) return xcv.arg[ptrIR];
      const f = this.jsFuncToWasm(v, WHAT_SIGNATURE);
    }.bind(target);
  }

  const __xArgAdapter =
        (t)=>xcv.arg[t] || toss("Argument adapter not found:",t);

  const __xResultAdapter =
        (t)=>xcv.result[t] || toss("Result adapter not found:",t);
  
  cache.xWrap.convertArg = (t,v)=>__xArgAdapter(t)(v);
  cache.xWrap.convertResult =
    (t,v)=>(null===t ? v : (t ? __xResultAdapter(t)(v) : undefined));

  /**
     Creates a wrapper for the WASM-exported function fname. Uses
     xGet() to fetch the exported function (which throws on
     error) and returns either that function or a wrapper for that
     function which converts the JS-side argument types into WASM-side
     types and converts the result type. If the function takes no
     arguments and resultType is `null` then the function is returned
     as-is, else a wrapper is created for it to adapt its arguments
     and result value, as described below.

     (If you're familiar with Emscripten's ccall() and cwrap(), this
     function is essentially cwrap() on steroids.)

     This function's arguments are:

     - fname: the exported function's name. xGet() is used to fetch
       this, so will throw if no exported function is found with that
       name.

     - resultType: the name of the result type. A literal `null` means
       to return the original function's value as-is (mnemonic: there
       is "null" conversion going on). Literal `undefined` or the
       string `"void"` mean to ignore the function's result and return
       `undefined`. Aside from those two special cases, it may be one
       of the values described below or any mapping installed by the
       client using xWrap.resultAdapter().

     If passed 3 arguments and the final one is an array, that array
     must contain a list of type names (see below) for adapting the
     arguments from JS to WASM.  If passed 2 arguments, more than 3,
     or the 3rd is not an array, all arguments after the 2nd (if any)
     are treated as type names. i.e.:

     ```
     xWrap('funcname', 'i32', 'string', 'f64');
     // is equivalent to:
     xWrap('funcname', 'i32', ['string', 'f64']);
     ```

     Type names are symbolic names which map the arguments to an
     adapter function to convert, if needed, the value before passing
     it on to WASM or to convert a return result from WASM. The list
     of built-in names:

     - `i8`, `i16`, `i32` (args and results): all integer conversions
       which convert their argument to an integer and truncate it to
       the given bit length.

     - `N*` (args): a type name in the form `N*`, where N is a numeric
       type name, is treated the same as WASM pointer.

     - `*` and `pointer` (args): have multple semantics. They
       behave exactly as described below for `string` args.

     - `*` and `pointer` (results): are aliases for the current
       WASM pointer numeric type.

     - `**` (args): is simply a descriptive alias for the WASM pointer
       type. It's primarily intended to mark output-pointer arguments.

     - `i64` (args and results): passes the value to BigInt() to
       convert it to an int64.

     - `f32` (`float`), `f64` (`double`) (args and results): pass
       their argument to Number(). i.e. the adaptor does not currently
       distinguish between the two types of floating-point numbers.

     Non-numeric conversions include:

     - `string` (args): has two different semantics in order to
       accommodate various uses of certain C APIs (e.g. output-style
       strings)...

       - If the arg is a string, it creates a _temporary_ C-string to
         pass to the exported function, cleaning it up before the
         wrapper returns. If a long-lived C-string pointer is
         required, that requires client-side code to create the
         string, then pass its pointer to the function.

       - Else the arg is assumed to be a pointer to a string the
         client has already allocated and it's passed on as
         a WASM pointer.

     - `string` (results): treats the result value as a const C-string,
       copies it to a JS string, and returns that JS string.

     - `string:free` (results): treats the result value as a non-const
       C-string, ownership of which has just been transfered to the
       caller. It copies the C-string to a JS string, frees the
       C-string, and returns the JS string. If such a result value is
       NULL, the JS result is `null`.

     - `json` (results): treats the result as a const C-string and
       returns the result of passing the converted-to-JS string to
       JSON.parse(). Returns `null` if the C-string is a NULL pointer.

     - `json:free` (results): works exactly like `string:free` but
       returns the same thing as the `json` adapter.

     The type names for results and arguments are validated when
     xWrap() is called and any unknown names will trigger an
     exception.

     Clients may map their own result and argument adapters using
     xWrap.resultAdapter() and xWrap.argAdaptor(), noting that not all
     type conversions are valid for both arguments _and_ result types
     as they often have different memory ownership requirements.

     TODOs:

     - Figure out how/whether we can (semi-)transparently handle
       pointer-type _output_ arguments. Those currently require
       explicit handling by allocating pointers, assigning them before
       the call using setMemValue(), and fetching them with
       getMemValue() after the call. We may be able to automate some
       or all of that.

     - Figure out whether it makes sense to extend the arg adapter
       interface such that each arg adapter gets an array containing
       the results of the previous arguments in the current call. That
       might allow some interesting type-conversion feature. Use case:
       handling of the final argument to sqlite3_prepare_v2() depends
       on the type (pointer vs JS string) of its 2nd
       argument. Currently that distinction requires hand-writing a
       wrapper for that function. That case is unusual enough that
       abstracting it into this API (and taking on the associated
       costs) may well not make good sense.
  */
  target.xWrap = function(fname, resultType, ...argTypes){
    if(3===arguments.length && Array.isArray(arguments[2])){
      argTypes = arguments[2];
    }
    const xf = this.xGet(fname);
    if(argTypes.length!==xf.length) __argcMismatch(fname, xf.length)
    if((null===resultType) && 0===xf.length){
      /* Func taking no args with an as-is return. We don't need a wrapper. */
      return xf;
    }
    /*Verify the arg type conversions are valid...*/;
    if(undefined!==resultType && null!==resultType) __xResultAdapter(resultType);
    argTypes.forEach(__xArgAdapter)
    if(0===xf.length){
      // No args to convert, so we can create a simpler wrapper...
      return function(){
        return (arguments.length
                ? __argcMismatch(fname, xf.length)
                : cache.xWrap.convertResult(resultType, xf.call(null)));
      };
    }
    return function(...args){
      if(args.length!==xf.length) __argcMismatch(fname, xf.length);
      const scope = this.scopedAllocPush();
      try{
        const rc = xf.apply(null,args.map((v,i)=>cache.xWrap.convertArg(argTypes[i], v)));
        return cache.xWrap.convertResult(resultType, rc);
      }finally{
        this.scopedAllocPop(scope);
      }
    }.bind(this);
  }.bind(target)/*xWrap()*/;

  /** Internal impl for xWrap.resultAdapter() and argAdaptor(). */
  const __xAdapter = function(func, argc, typeName, adapter, modeName, xcvPart){
    if('string'===typeof typeName){
      if(1===argc) return xcvPart[typeName];
      else if(2===argc){
        if(!adapter){
          delete xcvPart[typeName];
          return func;
        }else if(!(adapter instanceof Function)){
          toss(modeName,"requires a function argument.");
        }
        xcvPart[typeName] = adapter;
        return func;
      }
    }
    toss("Invalid arguments to",modeName);
  };

  /**
     Gets, sets, or removes a result value adapter for use with
     xWrap(). If passed only 1 argument, the adapter function for the
     given type name is returned.  If the second argument is explicit
     falsy (as opposed to defaulted), the adapter named by the first
     argument is removed. If the 2nd argument is not falsy, it must be
     a function which takes one value and returns a value appropriate
     for the given type name. The adapter may throw if its argument is
     not of a type it can work with. This function throws for invalid
     arguments.

     Example:

     ```
     xWrap.resultAdapter('twice',(v)=>v+v);
     ```

     xWrap.resultAdapter() MUST NOT use the scopedAlloc() family of
     APIs to allocate a result value. xWrap()-generated wrappers run
     in the context of scopedAllocPush() so that argument adapters can
     easily convert, e.g., to C-strings, and have them cleaned up
     automatically before the wrapper returns to the caller. Likewise,
     if a _result_ adapter uses scoped allocation, the result will be
     freed before because they would be freed before the wrapper
     returns, leading to chaos and undefined behavior.

     Except when called as a getter, this function returns itself.
  */
  target.xWrap.resultAdapter = function f(typeName, adapter){
    return __xAdapter(f, arguments.length, typeName, adapter,
                      'resultAdaptor()', xcv.result);
  };

  /**
     Functions identically to xWrap.resultAdapter() but applies to
     call argument conversions instead of result value conversions.

     xWrap()-generated wrappers perform argument conversion in the
     context of a scopedAllocPush(), so any memory allocation
     performed by argument adapters really, really, really should be
     made using the scopedAlloc() family of functions unless
     specifically necessary. For example:

     ```
     xWrap.argAdapter('my-string', function(v){
       return ('string'===typeof v)
         ? myWasmObj.scopedAllocCString(v) : null;
     };
     ```

     Contrariwise, xWrap.resultAdapter() must _not_ use scopedAlloc()
     to allocate its results because they would be freed before the
     xWrap()-created wrapper returns.

     Note that it is perfectly legitimate to use these adapters to
     perform argument validation, as opposed (or in addition) to
     conversion.
  */
  target.xWrap.argAdapter = function f(typeName, adapter){
    return __xAdapter(f, arguments.length, typeName, adapter,
                      'argAdaptor()', xcv.arg);
  };

  /**
     Functions like xCall() but performs argument and result type
     conversions as for xWrap(). The first argument is the name of the
     exported function to call. The 2nd its the name of its result
     type, as documented for xWrap(). The 3rd is an array of argument
     type name, as documented for xWrap() (use a falsy value or an
     empty array for nullary functions). The 4th+ arguments are
     arguments for the call, with the special case that if the 4th
     argument is an array, it is used as the arguments for the call
     (again, falsy or an empty array for nullary functions). Returns
     the converted result of the call.

     This is just a thin wrapp around xWrap(). If the given function
     is to be called more than once, it's more efficient to use
     xWrap() to create a wrapper, then to call that wrapper as many
     times as needed. For one-shot calls, however, this variant is
     arguably more efficient because it will hypothetically free the
     wrapper function quickly.
  */
  target.xCallWrapped = function(fname, resultType, argTypes, ...args){
    if(Array.isArray(arguments[3])) args = arguments[3];
    return this.xWrap(fname, resultType, argTypes||[]).apply(null, args||[]);
  }.bind(target);
  
  return target;
};

/**
   yawl (Yet Another Wasm Loader) provides very basic wasm loader.
   It requires a config object:

   - `uri`: required URI of the WASM file to load.

   - `onload(loadResult,config)`: optional callback. The first
     argument is the result object from
     WebAssembly.instanitate[Streaming](). The 2nd is the config
     object passed to this function. Described in more detail below.

   - `imports`: optional imports object for
     WebAssembly.instantiate[Streaming](). The default is am empty set
     of imports. If the module requires any imports, this object
     must include them.

   - `wasmUtilTarget`: optional object suitable for passing to
     WhWasmUtilInstaller(). If set, it gets passed to that function
     after the promise resolves. This function sets several properties
     on it before passing it on to that function (which sets many
     more):

     - `module`, `instance`: the properties from the
       instantiate[Streaming]() result.

     - If `instance.exports.memory` is _not_ set then it requires that
       `config.imports.env.memory` be set (else it throws), and
       assigns that to `target.memory`.

     - If `wasmUtilTarget.alloc` is not set and
       `instance.exports.malloc` is, it installs
       `wasmUtilTarget.alloc()` and `wasmUtilTarget.dealloc()`
       wrappers for the exports `malloc` and `free` functions.

   It returns a function which, when called, initiates loading of the
   module and returns a Promise. When that Promise resolves, it calls
   the `config.onload` callback (if set) and passes it
   `(loadResult,config)`, where `loadResult` is the result of
   WebAssembly.instantiate[Streaming](): an object in the form:

   ```
   {
     module: a WebAssembly.Module,
     instance: a WebAssembly.Instance
   }
   ```

   (Note that the initial `then()` attached to the promise gets only
   that object, and not the `config` one.)

   Error handling is up to the caller, who may attach a `catch()` call
   to the promise.
*/
self.WhWasmUtilInstaller.yawl = function(config){
  const wfetch = ()=>fetch(config.uri, {credentials: 'same-origin'});
  const wui = this;
  const finalThen = function(arg){
    //log("finalThen()",arg);
    if(config.wasmUtilTarget){
      const toss = (...args)=>{throw new Error(args.join(' '))};
      const tgt = config.wasmUtilTarget;
      tgt.module = arg.module;
      tgt.instance = arg.instance;
      //tgt.exports = tgt.instance.exports;
      if(!tgt.instance.exports.memory){
        /**
           WhWasmUtilInstaller requires either tgt.exports.memory
           (exported from WASM) or tgt.memory (JS-provided memory
           imported into WASM).
        */
        tgt.memory = (config.imports && config.imports.env
                      && config.imports.env.memory)
          || toss("Missing 'memory' object!");
      }
      if(!tgt.alloc && arg.instance.exports.malloc){
        tgt.alloc = function(n){
          return this(n) || toss("Allocation of",n,"bytes failed.");
        }.bind(arg.instance.exports.malloc);
        tgt.dealloc = function(m){this(m)}.bind(arg.instance.exports.free);
      }
      wui(tgt);
    }
    if(config.onload) config.onload(arg,config);
    return arg /* for any then() handler attached to
                  yetAnotherWasmLoader()'s return value */;
  };
  const loadWasm = WebAssembly.instantiateStreaming
        ? function loadWasmStreaming(){
          return WebAssembly.instantiateStreaming(wfetch(), config.imports||{})
            .then(finalThen);
        }
        : function loadWasmOldSchool(){ // Safari < v15
          return wfetch()
            .then(response => response.arrayBuffer())
            .then(bytes => WebAssembly.instantiate(bytes, config.imports||{}))
            .then(finalThen);
        };
  return loadWasm;
}.bind(self.WhWasmUtilInstaller)/*yawl()*/;
/* END FILE: common/whwasmutil.js */
/* BEGIN FILE: jaccwabyt/jaccwabyt.js */
/**
  2022-06-30

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  The Jaccwabyt API is documented in detail in an external file.

  Project home: https://fossil.wanderinghorse.net/r/jaccwabyt

*/
'use strict';
self.Jaccwabyt = function StructBinderFactory(config){
/* ^^^^ it is recommended that clients move that object into wherever
   they'd like to have it and delete the self-held copy ("self" being
   the global window or worker object).  This API does not require the
   global reference - it is simply installed as a convenience for
   connecting these bits to other co-developed code before it gets
   removed from the global namespace.
*/

  /** Throws a new Error, the message of which is the concatenation
      all args with a space between each. */
  const toss = (...args)=>{throw new Error(args.join(' '))};

  /**
     Implementing function bindings revealed significant
     shortcomings in Emscripten's addFunction()/removeFunction()
     interfaces:

     https://github.com/emscripten-core/emscripten/issues/17323

     Until those are resolved, or a suitable replacement can be
     implemented, our function-binding API will be more limited
     and/or clumsier to use than initially hoped.
  */
  if(!(config.heap instanceof WebAssembly.Memory)
     && !(config.heap instanceof Function)){
    toss("config.heap must be WebAssembly.Memory instance or a function.");
  }
  ['alloc','dealloc'].forEach(function(k){
    (config[k] instanceof Function) ||
      toss("Config option '"+k+"' must be a function.");
  });
  const SBF = StructBinderFactory;
  const heap = (config.heap instanceof Function)
        ? config.heap : (()=>new Uint8Array(config.heap.buffer)),
        alloc = config.alloc,
        dealloc = config.dealloc,
        log = config.log || console.log.bind(console),
        memberPrefix = (config.memberPrefix || ""),
        memberSuffix = (config.memberSuffix || ""),
        bigIntEnabled = (undefined===config.bigIntEnabled
                         ? !!self['BigInt64Array'] : !!config.bigIntEnabled),
        BigInt = self['BigInt'],
        BigInt64Array = self['BigInt64Array'],
        /* Undocumented (on purpose) config options: */
        functionTable = config.functionTable/*EXPERIMENTAL, undocumented*/,
        ptrSizeof = config.ptrSizeof || 4,
        ptrIR = config.ptrIR || 'i32'
  ;

  if(!SBF.debugFlags){
    SBF.__makeDebugFlags = function(deriveFrom=null){
      /* This is disgustingly overengineered. :/ */
      if(deriveFrom && deriveFrom.__flags) deriveFrom = deriveFrom.__flags;
      const f = function f(flags){
        if(0===arguments.length){
          return f.__flags;
        }
        if(flags<0){
          delete f.__flags.getter; delete f.__flags.setter;
          delete f.__flags.alloc; delete f.__flags.dealloc;
        }else{
          f.__flags.getter  = 0!==(0x01 & flags);
          f.__flags.setter  = 0!==(0x02 & flags);
          f.__flags.alloc   = 0!==(0x04 & flags);
          f.__flags.dealloc = 0!==(0x08 & flags);
        }
        return f._flags;
      };
      Object.defineProperty(f,'__flags', {
        iterable: false, writable: false,
        value: Object.create(deriveFrom)
      });
      if(!deriveFrom) f(0);
      return f;
    };
    SBF.debugFlags = SBF.__makeDebugFlags();
  }/*static init*/

  const isLittleEndian = (function() {
    const buffer = new ArrayBuffer(2);
    new DataView(buffer).setInt16(0, 256, true /* littleEndian */);
    // Int16Array uses the platform's endianness.
    return new Int16Array(buffer)[0] === 256;
  })();
  /**
     Some terms used in the internal docs:

     StructType: a struct-wrapping class generated by this
     framework.
     DEF: struct description object.
     SIG: struct member signature string.
  */

  /** True if SIG s looks like a function signature, else
      false. */
  const isFuncSig = (s)=>'('===s[1];
  /** True if SIG s is-a pointer signature. */
  const isPtrSig = (s)=>'p'===s || 'P'===s;
  const isAutoPtrSig = (s)=>'P'===s /*EXPERIMENTAL*/;
  const sigLetter = (s)=>isFuncSig(s) ? 'p' : s[0];
  /** Returns the WASM IR form of the Emscripten-conventional letter
      at SIG s[0]. Throws for an unknown SIG. */
  const sigIR = function(s){
    switch(sigLetter(s)){
        case 'i': return 'i32';
        case 'p': case 'P': case 's': return ptrIR;
        case 'j': return 'i64';
        case 'f': return 'float';
        case 'd': return 'double';
    }
    toss("Unhandled signature IR:",s);
  };
  /** Returns the sizeof value for the given SIG. Throws for an
      unknown SIG. */
  const sigSizeof = function(s){
    switch(sigLetter(s)){
        case 'i': return 4;
        case 'p': case 'P': case 's': return ptrSizeof;
        case 'j': return 8;
        case 'f': return 4 /* C-side floats, not JS-side */;
        case 'd': return 8;
    }
    toss("Unhandled signature sizeof:",s);
  };
  const affirmBigIntArray = BigInt64Array
        ? ()=>true : ()=>toss('BigInt64Array is not available.');
  /** Returns the (signed) TypedArray associated with the type
      described by the given SIG. Throws for an unknown SIG. */
  /**********
  const sigTypedArray = function(s){
    switch(sigIR(s)) {
        case 'i32': return Int32Array;
        case 'i64': return affirmBigIntArray() && BigInt64Array;
        case 'float': return Float32Array;
        case 'double': return Float64Array;
    }
    toss("Unhandled signature TypedArray:",s);
  };
  **************/
  /** Returns the name of a DataView getter method corresponding
      to the given SIG. */
  const sigDVGetter = function(s){
    switch(sigLetter(s)) {
        case 'p': case 'P': case 's': {
          switch(ptrSizeof){
              case 4: return 'getInt32';
              case 8: return affirmBigIntArray() && 'getBigInt64';
          }
          break;
        }
        case 'i': return 'getInt32';
        case 'j': return affirmBigIntArray() && 'getBigInt64';
        case 'f': return 'getFloat32';
        case 'd': return 'getFloat64';
    }
    toss("Unhandled DataView getter for signature:",s);
  };
  /** Returns the name of a DataView setter method corresponding
      to the given SIG. */
  const sigDVSetter = function(s){
    switch(sigLetter(s)){
        case 'p': case 'P': case 's': {
          switch(ptrSizeof){
              case 4: return 'setInt32';
              case 8: return affirmBigIntArray() && 'setBigInt64';
          }
          break;
        }
        case 'i': return 'setInt32';
        case 'j': return affirmBigIntArray() && 'setBigInt64';
        case 'f': return 'setFloat32';
        case 'd': return 'setFloat64';
    }
    toss("Unhandled DataView setter for signature:",s);
  };
  /**
     Returns either Number of BigInt, depending on the given
     SIG. This constructor is used in property setters to coerce
     the being-set value to the correct size.
  */
  const sigDVSetWrapper = function(s){
    switch(sigLetter(s)) {
        case 'i': case 'f': case 'd': return Number;
        case 'j': return affirmBigIntArray() && BigInt;
        case 'p': case 'P': case 's':
          switch(ptrSizeof){
              case 4: return Number;
              case 8: return affirmBigIntArray() && BigInt;
          }
          break;
    }
    toss("Unhandled DataView set wrapper for signature:",s);
  };

  const sPropName = (s,k)=>s+'::'+k;

  const __propThrowOnSet = function(structName,propName){
    return ()=>toss(sPropName(structName,propName),"is read-only.");
  };

  /**
     When C code passes a pointer of a bound struct to back into
     a JS function via a function pointer struct member, it
     arrives in JS as a number (pointer).
     StructType.instanceForPointer(ptr) can be used to get the
     instance associated with that pointer, and __ptrBacklinks
     holds that mapping. WeakMap keys must be objects, so we
     cannot use a weak map to map pointers to instances. We use
     the StructType constructor as the WeakMap key, mapped to a
     plain, prototype-less Object which maps the pointers to
     struct instances. That arrangement gives us a
     per-StructType type-safe way to resolve pointers.
  */
  const __ptrBacklinks = new WeakMap();
  /**
     Similar to __ptrBacklinks but is scoped at the StructBinder
     level and holds pointer-to-object mappings for all struct
     instances created by any struct from any StructFactory
     which this specific StructBinder has created. The intention
     of this is to help implement more transparent handling of
     pointer-type property resolution.
  */
  const __ptrBacklinksGlobal = Object.create(null);

  /**
     In order to completely hide StructBinder-bound struct
     pointers from JS code, we store them in a scope-local
     WeakMap which maps the struct-bound objects to their WASM
     pointers. The pointers are accessible via
     boundObject.pointer, which is gated behind an accessor
     function, but are not exposed anywhere else in the
     object. The main intention of that is to make it impossible
     for stale copies to be made.
  */
  const __instancePointerMap = new WeakMap();

  /** Property name for the pointer-is-external marker. */
  const xPtrPropName = '(pointer-is-external)';

  /** Frees the obj.pointer memory and clears the pointer
      property. */
  const __freeStruct = function(ctor, obj, m){
    if(!m) m = __instancePointerMap.get(obj);
    if(m) {
      if(obj.ondispose instanceof Function){
        try{obj.ondispose()}
        catch(e){
          /*do not rethrow: destructors must not throw*/
          console.warn("ondispose() for",ctor.structName,'@',
                       m,'threw. NOT propagating it.',e);
        }
      }else if(Array.isArray(obj.ondispose)){
        obj.ondispose.forEach(function(x){
          try{
            if(x instanceof Function) x.call(obj);
            else if('number' === typeof x) dealloc(x);
            // else ignore. Strings are permitted to annotate entries
            // to assist in debugging.
          }catch(e){
            console.warn("ondispose() for",ctor.structName,'@',
                         m,'threw. NOT propagating it.',e);
          }
        });
      }
      delete obj.ondispose;
      delete __ptrBacklinks.get(ctor)[m];
      delete __ptrBacklinksGlobal[m];
      __instancePointerMap.delete(obj);
      if(ctor.debugFlags.__flags.dealloc){
        log("debug.dealloc:",(obj[xPtrPropName]?"EXTERNAL":""),
            ctor.structName,"instance:",
            ctor.structInfo.sizeof,"bytes @"+m);
      }
      if(!obj[xPtrPropName]) dealloc(m);
    }
  };

  /** Returns a skeleton for a read-only property accessor wrapping
      value v. */
  const rop = (v)=>{return {configurable: false, writable: false,
                            iterable: false, value: v}};

  /** Allocates obj's memory buffer based on the size defined in
      DEF.sizeof. */
  const __allocStruct = function(ctor, obj, m){
    let fill = !m;
    if(m) Object.defineProperty(obj, xPtrPropName, rop(m));
    else{
      m = alloc(ctor.structInfo.sizeof);
      if(!m) toss("Allocation of",ctor.structName,"structure failed.");
    }
    try {
      if(ctor.debugFlags.__flags.alloc){
        log("debug.alloc:",(fill?"":"EXTERNAL"),
            ctor.structName,"instance:",
            ctor.structInfo.sizeof,"bytes @"+m);
      }
      if(fill) heap().fill(0, m, m + ctor.structInfo.sizeof);
      __instancePointerMap.set(obj, m);
      __ptrBacklinks.get(ctor)[m] = obj;
      __ptrBacklinksGlobal[m] = obj;
    }catch(e){
      __freeStruct(ctor, obj, m);
      throw e;
    }
  };
  /** Gets installed as the memoryDump() method of all structs. */
  const __memoryDump = function(){
    const p = this.pointer;
    return p
      ? new Uint8Array(heap().slice(p, p+this.structInfo.sizeof))
      : null;
  };

  const __memberKey = (k)=>memberPrefix + k + memberSuffix;
  const __memberKeyProp = rop(__memberKey);

  /**
     Looks up a struct member in structInfo.members. Throws if found
     if tossIfNotFound is true, else returns undefined if not
     found. The given name may be either the name of the
     structInfo.members key (faster) or the key as modified by the
     memberPrefix/memberSuffix settings.
  */
  const __lookupMember = function(structInfo, memberName, tossIfNotFound=true){
    let m = structInfo.members[memberName];
    if(!m && (memberPrefix || memberSuffix)){
      // Check for a match on members[X].key
      for(const v of Object.values(structInfo.members)){
        if(v.key===memberName){ m = v; break; }
      }
      if(!m && tossIfNotFound){
        toss(sPropName(structInfo.name,memberName),'is not a mapped struct member.');
      }
    }
    return m;
  };

  /**
     Uses __lookupMember(obj.structInfo,memberName) to find a member,
     throwing if not found. Returns its signature, either in this
     framework's native format or in Emscripten format.
  */
  const __memberSignature = function f(obj,memberName,emscriptenFormat=false){
    if(!f._) f._ = (x)=>x.replace(/[^vipPsjrd]/g,'').replace(/[pPs]/g,'i');
    const m = __lookupMember(obj.structInfo, memberName, true);
    return emscriptenFormat ? f._(m.signature) : m.signature;
  };

  /**
     Returns the instanceForPointer() impl for the given
     StructType constructor.
  */
  const __instanceBacklinkFactory = function(ctor){
    const b = Object.create(null);
    __ptrBacklinks.set(ctor, b);
    return (ptr)=>b[ptr];
  };

  const __ptrPropDescriptor = {
    configurable: false, enumerable: false,
    get: function(){return __instancePointerMap.get(this)},
    set: ()=>toss("Cannot assign the 'pointer' property of a struct.")
    // Reminder: leaving `set` undefined makes assignments
    // to the property _silently_ do nothing. Current unit tests
    // rely on it throwing, though.
  };

  /** Impl of X.memberKeys() for StructType and struct ctors. */
  const __structMemberKeys = rop(function(){
    const a = [];
    Object.keys(this.structInfo.members).forEach((k)=>a.push(this.memberKey(k)));
    return a;
  });

  const __utf8Decoder = new TextDecoder('utf-8');
  const __utf8Encoder = new TextEncoder();

  /**
     Uses __lookupMember() to find the given obj.structInfo key.
     Returns that member if it is a string, else returns false. If the
     member is not found, throws if tossIfNotFound is true, else
     returns false.
   */
  const __memberIsString = function(obj,memberName, tossIfNotFound=false){
    const m = __lookupMember(obj.structInfo, memberName, tossIfNotFound);
    return (m && 1===m.signature.length && 's'===m.signature[0]) ? m : false;
  };

  /**
     Given a member description object, throws if member.signature is
     not valid for assigning to or interpretation as a C-style string.
     It optimistically assumes that any signature of (i,p,s) is
     C-string compatible.
  */
  const __affirmCStringSignature = function(member){
    if('s'===member.signature) return;
    toss("Invalid member type signature for C-string value:",
         JSON.stringify(member));
  };

  /**
     Looks up the given member in obj.structInfo. If it has a
     signature of 's' then it is assumed to be a C-style UTF-8 string
     and a decoded copy of the string at its address is returned. If
     the signature is of any other type, it throws. If an s-type
     member's address is 0, `null` is returned.
  */
  const __memberToJsString = function f(obj,memberName){
    const m = __lookupMember(obj.structInfo, memberName, true);
    __affirmCStringSignature(m);
    const addr = obj[m.key];
    //log("addr =",addr,memberName,"m =",m);
    if(!addr) return null;
    let pos = addr;
    const mem = heap();
    for( ; mem[pos]!==0; ++pos ) {
      //log("mem[",pos,"]",mem[pos]);
    };
    //log("addr =",addr,"pos =",pos);
    if(addr===pos) return "";
    return __utf8Decoder.decode(new Uint8Array(mem.buffer, addr, pos-addr));
  };

  /**
     Adds value v to obj.ondispose, creating ondispose,
     or converting it to an array, if needed.
  */
  const __addOnDispose = function(obj, v){
    if(obj.ondispose){
      if(obj.ondispose instanceof Function){
        obj.ondispose = [obj.ondispose];
      }/*else assume it's an array*/
    }else{
      obj.ondispose = [];
    }
    obj.ondispose.push(v);
  };

  /**
     Allocates a new UTF-8-encoded, NUL-terminated copy of the given
     JS string and returns its address relative to heap(). If
     allocation returns 0 this function throws. Ownership of the
     memory is transfered to the caller, who must eventually pass it
     to the configured dealloc() function.
  */
  const __allocCString = function(str){
    const u = __utf8Encoder.encode(str);
    const mem = alloc(u.length+1);
    if(!mem) toss("Allocation error while duplicating string:",str);
    const h = heap();
    let i = 0;
    for( ; i < u.length; ++i ) h[mem + i] = u[i];
    h[mem + u.length] = 0;
    //log("allocCString @",mem," =",u);
    return mem;
  };

  /**
     Sets the given struct member of obj to a dynamically-allocated,
     UTF-8-encoded, NUL-terminated copy of str. It is up to the caller
     to free any prior memory, if appropriate. The newly-allocated
     string is added to obj.ondispose so will be freed when the object
     is disposed.
  */
  const __setMemberCString = function(obj, memberName, str){
    const m = __lookupMember(obj.structInfo, memberName, true);
    __affirmCStringSignature(m);
    /* Potential TODO: if obj.ondispose contains obj[m.key] then
       dealloc that value and clear that ondispose entry */
    const mem = __allocCString(str);
    obj[m.key] = mem;
    __addOnDispose(obj, mem);
    return obj;
  };

  /**
     Prototype for all StructFactory instances (the constructors
     returned from StructBinder).
  */
  const StructType = function ctor(structName, structInfo){
    if(arguments[2]!==rop){
      toss("Do not call the StructType constructor",
           "from client-level code.");
    }
    Object.defineProperties(this,{
      //isA: rop((v)=>v instanceof ctor),
      structName: rop(structName),
      structInfo: rop(structInfo)
    });
  };

  /**
     Properties inherited by struct-type-specific StructType instances
     and (indirectly) concrete struct-type instances.
  */
  StructType.prototype = Object.create(null, {
    dispose: rop(function(){__freeStruct(this.constructor, this)}),
    lookupMember: rop(function(memberName, tossIfNotFound=true){
      return __lookupMember(this.structInfo, memberName, tossIfNotFound);
    }),
    memberToJsString: rop(function(memberName){
      return __memberToJsString(this, memberName);
    }),
    memberIsString: rop(function(memberName, tossIfNotFound=true){
      return __memberIsString(this, memberName, tossIfNotFound);
    }),
    memberKey: __memberKeyProp,
    memberKeys: __structMemberKeys,
    memberSignature: rop(function(memberName, emscriptenFormat=false){
      return __memberSignature(this, memberName, emscriptenFormat);
    }),
    memoryDump: rop(__memoryDump),
    pointer: __ptrPropDescriptor,
    setMemberCString: rop(function(memberName, str){
      return __setMemberCString(this, memberName, str);
    })
  });

  /**
     "Static" properties for StructType.
  */
  Object.defineProperties(StructType, {
    allocCString: rop(__allocCString),
    instanceForPointer: rop((ptr)=>__ptrBacklinksGlobal[ptr]),
    isA: rop((v)=>v instanceof StructType),
    hasExternalPointer: rop((v)=>(v instanceof StructType) && !!v[xPtrPropName]),
    memberKey: __memberKeyProp
  });

  const isNumericValue = (v)=>Number.isFinite(v) || (v instanceof (BigInt || Number));

  /**
     Pass this a StructBinder-generated prototype, and the struct
     member description object. It will define property accessors for
     proto[memberKey] which read from/write to memory in
     this.pointer. It modifies descr to make certain downstream
     operations much simpler.
  */
  const makeMemberWrapper = function f(ctor,name, descr){
    if(!f._){
      /*cache all available getters/setters/set-wrappers for
        direct reuse in each accessor function. */
      f._ = {getters: {}, setters: {}, sw:{}};
      const a = ['i','p','P','s','f','d','v()'];
      if(bigIntEnabled) a.push('j');
      a.forEach(function(v){
        //const ir = sigIR(v);
        f._.getters[v] = sigDVGetter(v) /* DataView[MethodName] values for GETTERS */;
        f._.setters[v] = sigDVSetter(v) /* DataView[MethodName] values for SETTERS */;
        f._.sw[v] = sigDVSetWrapper(v)  /* BigInt or Number ctor to wrap around values
                                           for conversion */;
      });
      const rxSig1 = /^[ipPsjfd]$/,
            rxSig2 = /^[vipPsjfd]\([ipPsjfd]*\)$/;
      f.sigCheck = function(obj, name, key,sig){
        if(Object.prototype.hasOwnProperty.call(obj, key)){
          toss(obj.structName,'already has a property named',key+'.');
        }
        rxSig1.test(sig) || rxSig2.test(sig)
          || toss("Malformed signature for",
                  sPropName(obj.structName,name)+":",sig);
      };
    }
    const key = ctor.memberKey(name);
    f.sigCheck(ctor.prototype, name, key, descr.signature);
    descr.key = key;
    descr.name = name;
    const sizeOf = sigSizeof(descr.signature);
    const sigGlyph = sigLetter(descr.signature);
    const xPropName = sPropName(ctor.prototype.structName,key);
    const dbg = ctor.prototype.debugFlags.__flags;
    /*
      TODO?: set prototype of descr to an object which can set/fetch
      its prefered representation, e.g. conversion to string or mapped
      function. Advantage: we can avoid doing that via if/else if/else
      in the get/set methods.
    */
    const prop = Object.create(null);
    prop.configurable = false;
    prop.enumerable = false;
    prop.get = function(){
      if(dbg.getter){
        log("debug.getter:",f._.getters[sigGlyph],"for", sigIR(sigGlyph),
            xPropName,'@', this.pointer,'+',descr.offset,'sz',sizeOf);
      }
      let rc = (
        new DataView(heap().buffer, this.pointer + descr.offset, sizeOf)
      )[f._.getters[sigGlyph]](0, isLittleEndian);
      if(dbg.getter) log("debug.getter:",xPropName,"result =",rc);
      if(rc && isAutoPtrSig(descr.signature)){
        rc = StructType.instanceForPointer(rc) || rc;
        if(dbg.getter) log("debug.getter:",xPropName,"resolved =",rc);
      }                
      return rc;
    };
    if(descr.readOnly){
      prop.set = __propThrowOnSet(ctor.prototype.structName,key);
    }else{
      prop.set = function(v){
        if(dbg.setter){
          log("debug.setter:",f._.setters[sigGlyph],"for", sigIR(sigGlyph),
              xPropName,'@', this.pointer,'+',descr.offset,'sz',sizeOf, v);
        }
        if(!this.pointer){
          toss("Cannot set struct property on disposed instance.");
        }
        if(null===v) v = 0;
        else while(!isNumericValue(v)){
          if(isAutoPtrSig(descr.signature) && (v instanceof StructType)){
            // It's a struct instance: let's store its pointer value!
            v = v.pointer || 0;
            if(dbg.setter) log("debug.setter:",xPropName,"resolved to",v);
            break;
          }
          toss("Invalid value for pointer-type",xPropName+'.');
        }
        (
          new DataView(heap().buffer, this.pointer + descr.offset, sizeOf)
        )[f._.setters[sigGlyph]](0, f._.sw[sigGlyph](v), isLittleEndian);
      };
    }
    Object.defineProperty(ctor.prototype, key, prop);
  }/*makeMemberWrapper*/;
  
  /**
     The main factory function which will be returned to the
     caller.
  */
  const StructBinder = function StructBinder(structName, structInfo){
    if(1===arguments.length){
      structInfo = structName;
      structName = structInfo.name;
    }else if(!structInfo.name){
      structInfo.name = structName;
    }
    if(!structName) toss("Struct name is required.");
    let lastMember = false;
    Object.keys(structInfo.members).forEach((k)=>{
      const m = structInfo.members[k];
      if(!m.sizeof) toss(structName,"member",k,"is missing sizeof.");
      else if(0!==(m.sizeof%4)){
        toss(structName,"member",k,"sizeof is not aligned.");
      }
      else if(0!==(m.offset%4)){
        toss(structName,"member",k,"offset is not aligned.");
      }
      if(!lastMember || lastMember.offset < m.offset) lastMember = m;
    });
    if(!lastMember) toss("No member property descriptions found.");
    else if(structInfo.sizeof < lastMember.offset+lastMember.sizeof){
      toss("Invalid struct config:",structName,
           "max member offset ("+lastMember.offset+") ",
           "extends past end of struct (sizeof="+structInfo.sizeof+").");
    }
    const debugFlags = rop(SBF.__makeDebugFlags(StructBinder.debugFlags));
    /** Constructor for the StructCtor. */
    const StructCtor = function StructCtor(externalMemory){
      if(!(this instanceof StructCtor)){
        toss("The",structName,"constructor may only be called via 'new'.");
      }else if(arguments.length){
        if(externalMemory!==(externalMemory|0) || externalMemory<=0){
          toss("Invalid pointer value for",structName,"constructor.");
        }
        __allocStruct(StructCtor, this, externalMemory);
      }else{
        __allocStruct(StructCtor, this);
      }
    };
    Object.defineProperties(StructCtor,{
      debugFlags: debugFlags,
      disposeAll: rop(function(){
        const map = __ptrBacklinks.get(StructCtor);
        Object.keys(map).forEach(function(ptr){
          const b = map[ptr];
          if(b) __freeStruct(StructCtor, b, ptr);
        });
        __ptrBacklinks.set(StructCtor, Object.create(null));
        return StructCtor;
      }),
      instanceForPointer: rop(__instanceBacklinkFactory(StructCtor)),
      isA: rop((v)=>v instanceof StructCtor),
      memberKey: __memberKeyProp,
      memberKeys: __structMemberKeys,
      resolveToInstance: rop(function(v, throwIfNot=false){
        if(!(v instanceof StructCtor)){
          v = Number.isSafeInteger(v)
            ? StructCtor.instanceForPointer(v) : undefined;
        }
        if(!v && throwIfNot) toss("Value is-not-a",StructCtor.structName);
        return v;
      }),
      methodInfoForKey: rop(function(mKey){
      }),
      structInfo: rop(structInfo),
      structName: rop(structName)
    });
    StructCtor.prototype = new StructType(structName, structInfo, rop);
    Object.defineProperties(StructCtor.prototype,{
      debugFlags: debugFlags,
      constructor: rop(StructCtor)
      /*if we assign StructCtor.prototype and don't do
        this then StructCtor!==instance.constructor!*/
    });
    Object.keys(structInfo.members).forEach(
      (name)=>makeMemberWrapper(StructCtor, name, structInfo.members[name])
    );
    return StructCtor;
  };
  StructBinder.instanceForPointer = StructType.instanceForPointer;
  StructBinder.StructType = StructType;
  StructBinder.config = config;
  StructBinder.allocCString = __allocCString;
  if(!StructBinder.debugFlags){
    StructBinder.debugFlags = SBF.__makeDebugFlags(SBF.debugFlags);
  }
  return StructBinder;
}/*StructBinderFactory*/;
/* END FILE: jaccwabyt/jaccwabyt.js */
/* BEGIN FILE: api/sqlite3-api-glue.js */
/*
  2022-07-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file glues together disparate pieces of JS which are loaded in
  previous steps of the sqlite3-api.js bootstrapping process:
  sqlite3-api-prologue.js, whwasmutil.js, and jaccwabyt.js. It
  initializes the main API pieces so that the downstream components
  (e.g. sqlite3-api-oo1.js) have all that they need.
*/
(function(self){
  'use strict';
  const toss = (...args)=>{throw new Error(args.join(' '))};

  self.sqlite3 = self.sqlite3ApiBootstrap({
    Module: Module /* ==> Emscripten-style Module object. Currently
                      needs to be exposed here for test code. NOT part
                      of the public API. */,
    exports: Module['asm'],
    memory: Module.wasmMemory /* gets set if built with -sIMPORT_MEMORY */,
    bigIntEnabled: !!self.BigInt64Array,
    allocExportName: 'malloc',
    deallocExportName: 'free'
  });
  delete self.sqlite3ApiBootstrap;

  const sqlite3 = self.sqlite3;
  const capi = sqlite3.capi, wasm = capi.wasm, util = capi.util;
  self.WhWasmUtilInstaller(capi.wasm);
  delete self.WhWasmUtilInstaller;

  if(0){
    /*  "The problem" is that the following isn't type-safe.
        OTOH, nothing about WASM pointers is. */
    /**
       Add the `.pointer` xWrap() signature entry to extend
       the `pointer` arg handler to check for a `pointer`
       property. This can be used to permit, e.g., passing
       an SQLite3.DB instance to a C-style sqlite3_xxx function
       which takes an `sqlite3*` argument.
    */
    const oldP = wasm.xWrap.argAdapter('pointer');
    const adapter = function(v){
      if(v && 'object'===typeof v && v.constructor){
        const x = v.pointer;
        if(Number.isInteger(x)) return x;
        else toss("Invalid (object) type for pointer-type argument.");
      }
      return oldP(v);
    };
    wasm.xWrap.argAdapter('.pointer', adapter);
  }

  // WhWasmUtil.xWrap() bindings...
  {
    /**
       Add some descriptive xWrap() aliases for '*' intended to
       (A) initially improve readability/correctness of capi.signatures
       and (B) eventually perhaps provide some sort of type-safety
       in their conversions.
    */
    const aPtr = wasm.xWrap.argAdapter('*');
    wasm.xWrap.argAdapter('sqlite3*', aPtr)('sqlite3_stmt*', aPtr);

    /**
       Populate api object with sqlite3_...() by binding the "raw" wasm
       exports into type-converting proxies using wasm.xWrap().
    */
    for(const e of wasm.bindingSignatures){
      capi[e[0]] = wasm.xWrap.apply(null, e);
    }

    /* For functions which cannot work properly unless
       wasm.bigIntEnabled is true, install a bogus impl which
       throws if called when bigIntEnabled is false. */
    const fI64Disabled = function(fname){
      return ()=>toss(fname+"() disabled due to lack",
                      "of BigInt support in this build.");
    };
    for(const e of wasm.bindingSignatures.int64){
      capi[e[0]] = wasm.bigIntEnabled
        ? wasm.xWrap.apply(null, e)
        : fI64Disabled(e[0]);
    }

    if(wasm.exports.sqlite3_wasm_db_error){
      util.sqlite3_wasm_db_error = capi.wasm.xWrap(
        'sqlite3_wasm_db_error', 'int', 'sqlite3*', 'int', 'string'
      );
    }else{
      util.sqlite3_wasm_db_error = function(pDb,errCode,msg){
        console.warn("sqlite3_wasm_db_error() is not exported.",arguments);
        return errCode;
      };
    }

    /**
       When registering a VFS and its related components it may be
       necessary to ensure that JS keeps a reference to them to keep
       them from getting garbage collected. Simply pass each such value
       to this function and a reference will be held to it for the life
       of the app.
    */
    capi.sqlite3_vfs_register.addReference = function f(...args){
      if(!f._) f._ = [];
      f._.push(...args);
    };

  }/*xWrap() bindings*/;

  /**
     Scope-local holder of the two impls of sqlite3_prepare_v2/v3().
  */
  const __prepare = Object.create(null);
  /**
     This binding expects a JS string as its 2nd argument and
     null as its final argument. In order to compile multiple
     statements from a single string, the "full" impl (see
     below) must be used.
  */
  __prepare.basic = wasm.xWrap('sqlite3_prepare_v3',
                               "int", ["sqlite3*", "string",
                                       "int"/*MUST always be negative*/,
                                       "int", "**",
                                       "**"/*MUST be 0 or null or undefined!*/]);
  /**
     Impl which requires that the 2nd argument be a pointer
     to the SQL string, instead of being converted to a
     string. This variant is necessary for cases where we
     require a non-NULL value for the final argument
     (exec()'ing multiple statements from one input
     string). For simpler cases, where only the first
     statement in the SQL string is required, the wrapper
     named sqlite3_prepare_v2() is sufficient and easier to
     use because it doesn't require dealing with pointers.
  */
  __prepare.full = wasm.xWrap('sqlite3_prepare_v3',
                              "int", ["sqlite3*", "*", "int", "int",
                                      "**", "**"]);

  /* Documented in the api object's initializer. */
  capi.sqlite3_prepare_v3 = function f(pDb, sql, sqlLen, prepFlags, ppStmt, pzTail){
    /* 2022-07-08: xWrap() 'string' arg handling may be able do this
       special-case handling for us. It needs to be tested. Or maybe
       not: we always want to treat pzTail as null when passed a
       non-pointer SQL string and the argument adapters don't have
       enough state to know that. Maybe they could/should, by passing
       the currently-collected args as an array as the 2nd arg to the
       argument adapters? Or maybe we collect all args in an array,
       pass that to an optional post-args-collected callback, and give
       it a chance to manipulate the args before we pass them on? */
    if(util.isSQLableTypedArray(sql)) sql = util.typedArrayToString(sql);
    switch(typeof sql){
        case 'string': return __prepare.basic(pDb, sql, -1, prepFlags, ppStmt, null);
        case 'number': return __prepare.full(pDb, sql, sqlLen||-1, prepFlags, ppStmt, pzTail);
        default:
          return util.sqlite3_wasm_db_error(
            pDb, capi.SQLITE_MISUSE,
            "Invalid SQL argument type for sqlite3_prepare_v2/v3()."
          );
    }
  };

  capi.sqlite3_prepare_v2 =
    (pDb, sql, sqlLen, ppStmt, pzTail)=>capi.sqlite3_prepare_v3(pDb, sql, sqlLen, 0, ppStmt, pzTail);

  /**
     Install JS<->C struct bindings for the non-opaque struct types we
     need... */
  sqlite3.StructBinder = self.Jaccwabyt({
    heap: 0 ? wasm.memory : wasm.heap8u,
    alloc: wasm.alloc,
    dealloc: wasm.dealloc,
    functionTable: wasm.functionTable,
    bigIntEnabled: wasm.bigIntEnabled,
    memberPrefix: '$'
  });
  delete self.Jaccwabyt;

  {/* Import C-level constants and structs... */
    const cJson = wasm.xCall('sqlite3_wasm_enum_json');
    if(!cJson){
      toss("Maintenance required: increase sqlite3_wasm_enum_json()'s",
           "static buffer size!");
    }
    wasm.ctype = JSON.parse(wasm.cstringToJs(cJson));
    //console.debug('wasm.ctype length =',wasm.cstrlen(cJson));
    for(const t of ['access', 'blobFinalizers', 'dataTypes',
                    'encodings', 'flock', 'ioCap',
                    'openFlags', 'prepareFlags', 'resultCodes',
                    'syncFlags', 'udfFlags', 'version'
                   ]){
      for(const [k,v] of Object.entries(wasm.ctype[t])){
        capi[k] = v;
      }
    }
    /* Bind all registered C-side structs... */
    for(const s of wasm.ctype.structs){
      capi[s.name] = sqlite3.StructBinder(s);
    }
  }

})(self);
/* END FILE: api/sqlite3-api-glue.js */
/* BEGIN FILE: api/sqlite3-api-oo1.js */
/*
  2022-07-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file contains the so-called OO #1 API wrapper for the sqlite3
  WASM build. It requires that sqlite3-api-glue.js has already run
  and it installs its deliverable as self.sqlite3.oo1.
*/
(function(self){
  const toss = (...args)=>{throw new Error(args.join(' '))};

  const sqlite3 = self.sqlite3 || toss("Missing main sqlite3 object.");
  const capi = sqlite3.capi, util = capi.util;
  /* What follows is colloquially known as "OO API #1". It is a
     binding of the sqlite3 API which is designed to be run within
     the same thread (main or worker) as the one in which the
     sqlite3 WASM binding was initialized. This wrapper cannot use
     the sqlite3 binding if, e.g., the wrapper is in the main thread
     and the sqlite3 API is in a worker. */

  /**
     In order to keep clients from manipulating, perhaps
     inadvertently, the underlying pointer values of DB and Stmt
     instances, we'll gate access to them via the `pointer` property
     accessor and store their real values in this map. Keys = DB/Stmt
     objects, values = pointer values. This also unifies how those are
     accessed, for potential use downstream via custom
     capi.wasm.xWrap() function signatures which know how to extract
     it.
  */
  const __ptrMap = new WeakMap();
  /**
     Map of DB instances to objects, each object being a map of UDF
     names to wasm function _pointers_ added to that DB handle via
     createFunction().
  */
  const __udfMap = new WeakMap();
  /**
     Map of DB instances to objects, each object being a map of Stmt
     wasm pointers to Stmt objects.
  */
  const __stmtMap = new WeakMap();

  /** If object opts has _its own_ property named p then that
      property's value is returned, else dflt is returned. */
  const getOwnOption = (opts, p, dflt)=>
        opts.hasOwnProperty(p) ? opts[p] : dflt;

  /**
     An Error subclass specifically for reporting DB-level errors and
     enabling clients to unambiguously identify such exceptions.
  */
  class SQLite3Error extends Error {
    constructor(...args){
      super(...args);
      this.name = 'SQLite3Error';
    }
  };
  const toss3 = (...args)=>{throw new SQLite3Error(args)};
  sqlite3.SQLite3Error = SQLite3Error;

  /**
     The DB class provides a high-level OO wrapper around an sqlite3
     db handle.

     The given db filename must be resolvable using whatever
     filesystem layer (virtual or otherwise) is set up for the default
     sqlite3 VFS.

     Note that the special sqlite3 db names ":memory:" and ""
     (temporary db) have their normal special meanings here and need
     not resolve to real filenames, but "" uses an on-storage
     temporary database and requires that the VFS support that.

     The db is currently opened with a fixed set of flags:
     (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE |
     SQLITE_OPEN_EXRESCODE).  This API will change in the future
     permit the caller to provide those flags via an additional
     argument.

     For purposes of passing a DB instance to C-style sqlite3
     functions, its read-only `pointer` property holds its `sqlite3*`
     pointer value. That property can also be used to check whether
     this DB instance is still open.
  */
  const DB = function ctor(fn=':memory:'){
    if('string'!==typeof fn){
      toss3("Invalid filename for DB constructor.");
    }
    const stack = capi.wasm.scopedAllocPush();
    let ptr;
    try {
      const ppDb = capi.wasm.scopedAllocPtr() /* output (sqlite3**) arg */;
      const rc = capi.sqlite3_open_v2(fn, ppDb, capi.SQLITE_OPEN_READWRITE
                                      | capi.SQLITE_OPEN_CREATE
                                      | capi.SQLITE_OPEN_EXRESCODE, null);
      ptr = capi.wasm.getMemValue(ppDb, '*');
      ctor.checkRc(ptr, rc);
    }catch(e){
      if(ptr) capi.sqlite3_close_v2(ptr);
      throw e;
    }
    finally{capi.wasm.scopedAllocPop(stack);}
    this.filename = fn;
    __ptrMap.set(this, ptr);
    __stmtMap.set(this, Object.create(null));
    __udfMap.set(this, Object.create(null));
  };

  /**
     Internal-use enum for mapping JS types to DB-bindable types.
     These do not (and need not) line up with the SQLITE_type
     values. All values in this enum must be truthy and distinct
     but they need not be numbers.
  */
  const BindTypes = {
    null: 1,
    number: 2,
    string: 3,
    boolean: 4,
    blob: 5
  };
  BindTypes['undefined'] == BindTypes.null;
  if(capi.wasm.bigIntEnabled){
    BindTypes.bigint = BindTypes.number;
  }

  /**
     This class wraps sqlite3_stmt. Calling this constructor
     directly will trigger an exception. Use DB.prepare() to create
     new instances.

     For purposes of passing a Stmt instance to C-style sqlite3
     functions, its read-only `pointer` property holds its `sqlite3_stmt*`
     pointer value.
  */
  const Stmt = function(){
    if(BindTypes!==arguments[2]){
      toss3("Do not call the Stmt constructor directly. Use DB.prepare().");
    }
    this.db = arguments[0];
    __ptrMap.set(this, arguments[1]);
    this.columnCount = capi.sqlite3_column_count(this.pointer);
    this.parameterCount = capi.sqlite3_bind_parameter_count(this.pointer);
  };

  /** Throws if the given DB has been closed, else it is returned. */
  const affirmDbOpen = function(db){
    if(!db.pointer) toss3("DB has been closed.");
    return db;
  };

  /** Throws if ndx is not an integer or if it is out of range
      for stmt.columnCount, else returns stmt.

      Reminder: this will also fail after the statement is finalized
      but the resulting error will be about an out-of-bounds column
      index.
  */
  const affirmColIndex = function(stmt,ndx){
    if((ndx !== (ndx|0)) || ndx<0 || ndx>=stmt.columnCount){
      toss3("Column index",ndx,"is out of range.");
    }
    return stmt;
  };

  /**
     Expects to be passed (arguments) from DB.exec() and
     DB.execMulti(). Does the argument processing/validation, throws
     on error, and returns a new object on success:

     { sql: the SQL, opt: optionsObj, cbArg: function}

     cbArg is only set if the opt.callback is set, in which case
     it's a function which expects to be passed the current Stmt
     and returns the callback argument of the type indicated by
     the input arguments.
  */
  const parseExecArgs = function(args){
    const out = Object.create(null);
    out.opt = Object.create(null);
    switch(args.length){
        case 1:
          if('string'===typeof args[0] || util.isSQLableTypedArray(args[0])){
            out.sql = args[0];
          }else if(args[0] && 'object'===typeof args[0]){
            out.opt = args[0];
            out.sql = out.opt.sql;
          }
          break;
        case 2:
          out.sql = args[0];
          out.opt = args[1];
          break;
        default: toss3("Invalid argument count for exec().");
    };
    if(util.isSQLableTypedArray(out.sql)){
      out.sql = util.typedArrayToString(out.sql);
    }else if(Array.isArray(out.sql)){
      out.sql = out.sql.join('');
    }else if('string'!==typeof out.sql){
      toss3("Missing SQL argument.");
    }
    if(out.opt.callback || out.opt.resultRows){
      switch((undefined===out.opt.rowMode)
             ? 'stmt' : out.opt.rowMode) {
          case 'object': out.cbArg = (stmt)=>stmt.get({}); break;
          case 'array': out.cbArg = (stmt)=>stmt.get([]); break;
          case 'stmt':
            if(Array.isArray(out.opt.resultRows)){
              toss3("Invalid rowMode for resultRows array: must",
                    "be one of 'array', 'object',",
                    "or a result column number.");
            }
            out.cbArg = (stmt)=>stmt;
            break;
          default:
            if(util.isInt32(out.opt.rowMode)){
              out.cbArg = (stmt)=>stmt.get(out.opt.rowMode);
              break;
            }
            toss3("Invalid rowMode:",out.opt.rowMode);
      }
    }
    return out;
  };

  /**
     Expects to be given a DB instance or an `sqlite3*` pointer, and an
     sqlite3 API result code. If the result code is not falsy, this
     function throws an SQLite3Error with an error message from
     sqlite3_errmsg(), using dbPtr as the db handle. Note that if it's
     passed a non-error code like SQLITE_ROW or SQLITE_DONE, it will
     still throw but the error string might be "Not an error."  The
     various non-0 non-error codes need to be checked for in client
     code where they are expected.
  */
  DB.checkRc = function(dbPtr, sqliteResultCode){
    if(sqliteResultCode){
      if(dbPtr instanceof DB) dbPtr = dbPtr.pointer;
      throw new SQLite3Error([
        "sqlite result code",sqliteResultCode+":",
        capi.sqlite3_errmsg(dbPtr) || "Unknown db error."
      ].join(' '));
    }
  };

  DB.prototype = {
    /**
       Finalizes all open statements and closes this database
       connection. This is a no-op if the db has already been
       closed. After calling close(), `this.pointer` will resolve to
       `undefined`, so that can be used to check whether the db
       instance is still opened.
    */
    close: function(){
      if(this.pointer){
        const pDb = this.pointer;
        let s;
        const that = this;
        Object.keys(__stmtMap.get(this)).forEach((k,s)=>{
          if(s && s.pointer) s.finalize();
        });
        Object.values(__udfMap.get(this)).forEach(
          capi.wasm.uninstallFunction.bind(capi.wasm)
        );
        __ptrMap.delete(this);
        __stmtMap.delete(this);
        __udfMap.delete(this);
        capi.sqlite3_close_v2(pDb);
        delete this.filename;
      }
    },
    /**
       Returns the number of changes, as per sqlite3_changes()
       (if the first argument is false) or sqlite3_total_changes()
       (if it's true). If the 2nd argument is true, it uses
       sqlite3_changes64() or sqlite3_total_changes64(), which
       will trigger an exception if this build does not have
       BigInt support enabled.
    */
    changes: function(total=false,sixtyFour=false){
      const p = affirmDbOpen(this).pointer;
      if(total){
        return sixtyFour
          ? capi.sqlite3_total_changes64(p)
          : capi.sqlite3_total_changes(p);
      }else{
        return sixtyFour
          ? capi.sqlite3_changes64(p)
          : capi.sqlite3_changes(p);
      }
    },
    /**
       Similar to this.filename but will return NULL for
       special names like ":memory:". Not of much use until
       we have filesystem support. Throws if the DB has
       been closed. If passed an argument it then it will return
       the filename of the ATTACHEd db with that name, else it assumes
       a name of `main`.
    */
    fileName: function(dbName){
      return capi.sqlite3_db_filename(affirmDbOpen(this).pointer, dbName||"main");
    },
    /**
       Returns true if this db instance has a name which resolves to a
       file. If the name is "" or ":memory:", it resolves to false.
       Note that it is not aware of the peculiarities of URI-style
       names and a URI-style name for a ":memory:" db will fool it.
    */
    hasFilename: function(){
      const fn = this.filename;
      if(!fn || ':memory'===fn) return false;
      return true;
    },
    /**
       Returns the name of the given 0-based db number, as documented
       for sqlite3_db_name().
    */
    dbName: function(dbNumber=0){
      return capi.sqlite3_db_name(affirmDbOpen(this).pointer, dbNumber);
    },
    /**
       Compiles the given SQL and returns a prepared Stmt. This is
       the only way to create new Stmt objects. Throws on error.

       The given SQL must be a string, a Uint8Array holding SQL, or a
       WASM pointer to memory holding the NUL-terminated SQL string.
       If the SQL contains no statements, an SQLite3Error is thrown.

       Design note: the C API permits empty SQL, reporting it as a 0
       result code and a NULL stmt pointer. Supporting that case here
       would cause extra work for all clients: any use of the Stmt API
       on such a statement will necessarily throw, so clients would be
       required to check `stmt.pointer` after calling `prepare()` in
       order to determine whether the Stmt instance is empty or not.
       Long-time practice (with other sqlite3 script bindings)
       suggests that the empty-prepare case is sufficiently rare (and
       useless) that supporting it here would simply hurt overall
       usability.
    */
    prepare: function(sql){
      affirmDbOpen(this);
      const stack = capi.wasm.scopedAllocPush();
      let ppStmt, pStmt;
      try{
        ppStmt = capi.wasm.scopedAllocPtr()/* output (sqlite3_stmt**) arg */;
        DB.checkRc(this, capi.sqlite3_prepare_v2(this.pointer, sql, -1, ppStmt, null));
        pStmt = capi.wasm.getMemValue(ppStmt, '*');
      }
      finally {capi.wasm.scopedAllocPop(stack)}
      if(!pStmt) toss3("Cannot prepare empty SQL.");
      const stmt = new Stmt(this, pStmt, BindTypes);
      __stmtMap.get(this)[pStmt] = stmt;
      return stmt;
    },
    /**
       This function works like execMulti(), and takes most of the
       same arguments, but is more efficient (performs much less
       work) when the input SQL is only a single statement. If
       passed a multi-statement SQL, it only processes the first
       one.

       This function supports the following additional options not
       supported by execMulti():

       - .multi: if true, this function acts as a proxy for
       execMulti() and behaves identically to that function.

       - .columnNames: if this is an array and the query has
       result columns, the array is passed to
       Stmt.getColumnNames() to append the column names to it
       (regardless of whether the query produces any result
       rows). If the query has no result columns, this value is
       unchanged.

       The following options to execMulti() are _not_ supported by
       this method (they are simply ignored):

       - .saveSql
    */
    exec: function(/*(sql [,optionsObj]) or (optionsObj)*/){
      affirmDbOpen(this);
      const arg = parseExecArgs(arguments);
      if(!arg.sql) return this;
      else if(arg.opt.multi){
        return this.execMulti(arg, undefined, BindTypes);
      }
      const opt = arg.opt;
      let stmt, rowTarget;
      try {
        if(Array.isArray(opt.resultRows)){
          rowTarget = opt.resultRows;
        }
        stmt = this.prepare(arg.sql);
        if(stmt.columnCount && Array.isArray(opt.columnNames)){
          stmt.getColumnNames(opt.columnNames);
        }
        if(opt.bind) stmt.bind(opt.bind);
        if(opt.callback || rowTarget){
          while(stmt.step()){
            const row = arg.cbArg(stmt);
            if(rowTarget) rowTarget.push(row);
            if(opt.callback){
              stmt._isLocked = true;
              opt.callback(row, stmt);
              stmt._isLocked = false;
            }
          }
        }else{
          stmt.step();
        }
      }finally{
        if(stmt){
          delete stmt._isLocked;
          stmt.finalize();
        }
      }
      return this;
    }/*exec()*/,
    /**
       Executes one or more SQL statements in the form of a single
       string. Its arguments must be either (sql,optionsObject) or
       (optionsObject). In the latter case, optionsObject.sql
       must contain the SQL to execute. Returns this
       object. Throws on error.

       If no SQL is provided, or a non-string is provided, an
       exception is triggered. Empty SQL, on the other hand, is
       simply a no-op.

       The optional options object may contain any of the following
       properties:

       - .sql = the SQL to run (unless it's provided as the first
       argument). This must be of type string, Uint8Array, or an
       array of strings (in which case they're concatenated
       together as-is, with no separator between elements,
       before evaluation).

       - .bind = a single value valid as an argument for
       Stmt.bind(). This is ONLY applied to the FIRST non-empty
       statement in the SQL which has any bindable
       parameters. (Empty statements are skipped entirely.)

       - .callback = a function which gets called for each row of
       the FIRST statement in the SQL which has result
       _columns_, but only if that statement has any result
       _rows_. The second argument passed to the callback is
       always the current Stmt object (so that the caller may
       collect column names, or similar). The first argument
       passed to the callback defaults to the current Stmt
       object but may be changed with ...

       - .rowMode = either a string describing what type of argument
       should be passed as the first argument to the callback or an
       integer representing a result column index. A `rowMode` of
       'object' causes the results of `stmt.get({})` to be passed to
       the `callback` and/or appended to `resultRows`. A value of
       'array' causes the results of `stmt.get([])` to be passed to
       passed on.  A value of 'stmt' is equivalent to the default,
       passing the current Stmt to the callback (noting that it's
       always passed as the 2nd argument), but this mode will trigger
       an exception if `resultRows` is an array. If `rowMode` is an
       integer, only the single value from that result column will be
       passed on. Any other value for the option triggers an
       exception.

       - .resultRows: if this is an array, it functions similarly to
       the `callback` option: each row of the result set (if any) of
       the FIRST first statement which has result _columns_ is
       appended to the array in the format specified for the `rowMode`
       option, with the exception that the only legal values for
       `rowMode` in this case are 'array' or 'object', neither of
       which is the default. It is legal to use both `resultRows` and
       `callback`, but `resultRows` is likely much simpler to use for
       small data sets and can be used over a WebWorker-style message
       interface.  execMulti() throws if `resultRows` is set and
       `rowMode` is 'stmt' (which is the default!).

       - saveSql = an optional array. If set, the SQL of each
       executed statement is appended to this array before the
       statement is executed (but after it is prepared - we
       don't have the string until after that). Empty SQL
       statements are elided.

       See also the exec() method, which is a close cousin of this
       one.

       ACHTUNG #1: The callback MUST NOT modify the Stmt
       object. Calling any of the Stmt.get() variants,
       Stmt.getColumnName(), or similar, is legal, but calling
       step() or finalize() is not. Routines which are illegal
       in this context will trigger an exception.

       ACHTUNG #2: The semantics of the `bind` and `callback`
       options may well change or those options may be removed
       altogether for this function (but retained for exec()).
       Generally speaking, neither bind parameters nor a callback
       are generically useful when executing multi-statement SQL.
    */
    execMulti: function(/*(sql [,obj]) || (obj)*/){
      affirmDbOpen(this);
      const wasm = capi.wasm;
      const arg = (BindTypes===arguments[2]
                   /* ^^^ Being passed on from exec() */
                   ? arguments[0] : parseExecArgs(arguments));
      if(!arg.sql) return this;
      const opt = arg.opt;
      const callback = opt.callback;
      const resultRows = (Array.isArray(opt.resultRows)
                          ? opt.resultRows : undefined);
      if(resultRows && 'stmt'===opt.rowMode){
        toss3("rowMode 'stmt' is not valid in combination",
              "with a resultRows array.");
      }
      let rowMode = (((callback||resultRows) && (undefined!==opt.rowMode))
                     ? opt.rowMode : undefined);
      let stmt;
      let bind = opt.bind;
      const stack = wasm.scopedAllocPush();
      try{
        const isTA = util.isSQLableTypedArray(arg.sql)
        /* Optimization: if the SQL is a TypedArray we can save some string
           conversion costs. */;
        /* Allocate the two output pointers (ppStmt, pzTail) and heap
           space for the SQL (pSql). When prepare_v2() returns, pzTail
           will point to somewhere in pSql. */
        let sqlByteLen = isTA ? arg.sql.byteLength : wasm.jstrlen(arg.sql);
        const ppStmt  = wasm.scopedAlloc(/* output (sqlite3_stmt**) arg and pzTail */
          (2 * wasm.ptrSizeof)
          + (sqlByteLen + 1/* SQL + NUL */));
        const pzTail = ppStmt + wasm.ptrSizeof /* final arg to sqlite3_prepare_v2() */;
        let pSql = pzTail + wasm.ptrSizeof;
        const pSqlEnd = pSql + sqlByteLen;
        if(isTA) wasm.heap8().set(arg.sql, pSql);
        else wasm.jstrcpy(arg.sql, wasm.heap8(), pSql, sqlByteLen, false);
        wasm.setMemValue(pSql + sqlByteLen, 0/*NUL terminator*/);
        while(wasm.getMemValue(pSql, 'i8')
              /* Maintenance reminder:   ^^^^ _must_ be i8 or else we
                 will very likely cause an endless loop. What that's
                 doing is checking for a terminating NUL byte. If we
                 use i32 or similar then we read 4 bytes, read stuff
                 around the NUL terminator, and get stuck in and
                 endless loop at the end of the SQL, endlessly
                 re-preparing an empty statement. */ ){
          wasm.setMemValue(ppStmt, 0, wasm.ptrIR);
          wasm.setMemValue(pzTail, 0, wasm.ptrIR);
          DB.checkRc(this, capi.sqlite3_prepare_v2(
            this.pointer, pSql, sqlByteLen, ppStmt, pzTail
          ));
          const pStmt = wasm.getMemValue(ppStmt, wasm.ptrIR);
          pSql = wasm.getMemValue(pzTail, wasm.ptrIR);
          sqlByteLen = pSqlEnd - pSql;
          if(!pStmt) continue;
          if(Array.isArray(opt.saveSql)){
            opt.saveSql.push(capi.sqlite3_sql(pStmt).trim());
          }
          stmt = new Stmt(this, pStmt, BindTypes);
          if(bind && stmt.parameterCount){
            stmt.bind(bind);
            bind = null;
          }
          if(stmt.columnCount && undefined!==rowMode){
            /* Only forward SELECT results for the FIRST query
               in the SQL which potentially has them. */
            while(stmt.step()){
              stmt._isLocked = true;
              const row = arg.cbArg(stmt);
              if(callback) callback(row, stmt);
              if(resultRows) resultRows.push(row);
              stmt._isLocked = false;
            }
            rowMode = undefined;
          }else{
            // Do we need to while(stmt.step()){} here?
            stmt.step();
          }
          stmt.finalize();
          stmt = null;
        }
      }catch(e){
        console.warn("DB.execMulti() is propagating exception",opt,e);
        throw e;
      }finally{
        if(stmt){
          delete stmt._isLocked;
          stmt.finalize();
        }
        wasm.scopedAllocPop(stack);
      }
      return this;
    }/*execMulti()*/,
    /**
       Creates a new scalar UDF (User-Defined Function) which is
       accessible via SQL code. This function may be called in any
       of the following forms:

       - (name, function)
       - (name, function, optionsObject)
       - (name, optionsObject)
       - (optionsObject)

       In the final two cases, the function must be defined as the
       'callback' property of the options object. In the final
       case, the function's name must be the 'name' property.

       This can only be used to create scalar functions, not
       aggregate or window functions. UDFs cannot be removed from
       a DB handle after they're added.

       On success, returns this object. Throws on error.

       When called from SQL, arguments to the UDF, and its result,
       will be converted between JS and SQL with as much fidelity
       as is feasible, triggering an exception if a type
       conversion cannot be determined. Some freedom is afforded
       to numeric conversions due to friction between the JS and C
       worlds: integers which are larger than 32 bits will be
       treated as doubles, as JS does not support 64-bit integers
       and it is (as of this writing) illegal to use WASM
       functions which take or return 64-bit integers from JS.

       The optional options object may contain flags to modify how
       the function is defined:

       - .arity: the number of arguments which SQL calls to this
       function expect or require. The default value is the
       callback's length property (i.e. the number of declared
       parameters it has). A value of -1 means that the function
       is variadic and may accept any number of arguments, up to
       sqlite3's compile-time limits. sqlite3 will enforce the
       argument count if is zero or greater.

       The following properties correspond to flags documented at:

       https://sqlite.org/c3ref/create_function.html

       - .deterministic = SQLITE_DETERMINISTIC
       - .directOnly = SQLITE_DIRECTONLY
       - .innocuous = SQLITE_INNOCUOUS

       Maintenance reminder: the ability to add new
       WASM-accessible functions to the runtime requires that the
       WASM build is compiled with emcc's `-sALLOW_TABLE_GROWTH`
       flag.
    */
    createFunction: function f(name, callback,opt){
      switch(arguments.length){
          case 1: /* (optionsObject) */
            opt = name;
            name = opt.name;
            callback = opt.callback;
            break;
          case 2: /* (name, callback|optionsObject) */
            if(!(callback instanceof Function)){
              opt = callback;
              callback = opt.callback;
            }
            break;
          default: break;
      }
      if(!opt) opt = {};
      if(!(callback instanceof Function)){
        toss3("Invalid arguments: expecting a callback function.");
      }else if('string' !== typeof name){
        toss3("Invalid arguments: missing function name.");
      }
      if(!f._extractArgs){
        /* Static init */
        f._extractArgs = function(argc, pArgv){
          let i, pVal, valType, arg;
          const tgt = [];
          for(i = 0; i < argc; ++i){
            pVal = capi.wasm.getMemValue(pArgv + (capi.wasm.ptrSizeof * i),
                                        capi.wasm.ptrIR);
            /**
               Curiously: despite ostensibly requiring 8-byte
               alignment, the pArgv array is parcelled into chunks of
               4 bytes (1 pointer each). The values those point to
               have 8-byte alignment but the individual argv entries
               do not.
            */            
            valType = capi.sqlite3_value_type(pVal);
            switch(valType){
                case capi.SQLITE_INTEGER:
                case capi.SQLITE_FLOAT:
                  arg = capi.sqlite3_value_double(pVal);
                  break;
                case capi.SQLITE_TEXT:
                  arg = capi.sqlite3_value_text(pVal);
                  break;
                case capi.SQLITE_BLOB:{
                  const n = capi.sqlite3_value_bytes(pVal);
                  const pBlob = capi.sqlite3_value_blob(pVal);
                  arg = new Uint8Array(n);
                  let i;
                  const heap = n ? capi.wasm.heap8() : false;
                  for(i = 0; i < n; ++i) arg[i] = heap[pBlob+i];
                  break;
                }
                case capi.SQLITE_NULL:
                  arg = null; break;
                default:
                  toss3("Unhandled sqlite3_value_type()",valType,
                        "is possibly indicative of incorrect",
                        "pointer size assumption.");
            }
            tgt.push(arg);
          }
          return tgt;
        }/*_extractArgs()*/;
        f._setResult = function(pCx, val){
          switch(typeof val) {
              case 'boolean':
                capi.sqlite3_result_int(pCx, val ? 1 : 0);
                break;
              case 'number': {
                (util.isInt32(val)
                 ? capi.sqlite3_result_int
                 : capi.sqlite3_result_double)(pCx, val);
                break;
              }
              case 'string':
                capi.sqlite3_result_text(pCx, val, -1, capi.SQLITE_TRANSIENT);
                break;
              case 'object':
                if(null===val) {
                  capi.sqlite3_result_null(pCx);
                  break;
                }else if(util.isBindableTypedArray(val)){
                  const pBlob = capi.wasm.mallocFromTypedArray(val);
                  capi.sqlite3_result_blob(pCx, pBlob, val.byteLength,
                                          capi.SQLITE_TRANSIENT);
                  capi.wasm.dealloc(pBlob);
                  break;
                }
                // else fall through
              default:
                toss3("Don't not how to handle this UDF result value:",val);
          };
        }/*_setResult()*/;
      }/*static init*/
      const wrapper = function(pCx, argc, pArgv){
        try{
          f._setResult(pCx, callback.apply(null, f._extractArgs(argc, pArgv)));
        }catch(e){
          if(e instanceof capi.WasmAllocError){
            capi.sqlite3_result_error_nomem(pCx);
          }else{
            capi.sqlite3_result_error(pCx, e.message, -1);
          }
        }
      };
      const pUdf = capi.wasm.installFunction(wrapper, "v(iii)");
      let fFlags = 0 /*flags for sqlite3_create_function_v2()*/;
      if(getOwnOption(opt, 'deterministic')) fFlags |= capi.SQLITE_DETERMINISTIC;
      if(getOwnOption(opt, 'directOnly')) fFlags |= capi.SQLITE_DIRECTONLY;
      if(getOwnOption(opt, 'innocuous')) fFlags |= capi.SQLITE_INNOCUOUS;
      name = name.toLowerCase();
      try {
        DB.checkRc(this, capi.sqlite3_create_function_v2(
          this.pointer, name,
          (opt.hasOwnProperty('arity') ? +opt.arity : callback.length),
          capi.SQLITE_UTF8 | fFlags, null/*pApp*/, pUdf,
          null/*xStep*/, null/*xFinal*/, null/*xDestroy*/));
      }catch(e){
        capi.wasm.uninstallFunction(pUdf);
        throw e;
      }
      const udfMap = __udfMap.get(this);
      if(udfMap[name]){
        try{capi.wasm.uninstallFunction(udfMap[name])}
        catch(e){/*ignore*/}
      }
      udfMap[name] = pUdf;
      return this;
    }/*createFunction()*/,
    /**
       Prepares the given SQL, step()s it one time, and returns
       the value of the first result column. If it has no results,
       undefined is returned.

       If passed a second argument, it is treated like an argument
       to Stmt.bind(), so may be any type supported by that
       function. Passing the undefined value is the same as passing
       no value, which is useful when...

       If passed a 3rd argument, it is expected to be one of the
       SQLITE_{typename} constants. Passing the undefined value is
       the same as not passing a value.

       Throws on error (e.g. malformedSQL).
    */
    selectValue: function(sql,bind,asType){
      let stmt, rc;
      try {
        stmt = this.prepare(sql).bind(bind);
        if(stmt.step()) rc = stmt.get(0,asType);
      }finally{
        if(stmt) stmt.finalize();
      }
      return rc;
    },

    /**
       Returns the number of currently-opened Stmt handles for this db
       handle, or 0 if this DB instance is closed.
    */
    openStatementCount: function(){
      return this.pointer ? Object.keys(__stmtMap.get(this)).length : 0;
    },

    /**
       This function currently does nothing and always throws.  It
       WILL BE REMOVED pending other refactoring, to eliminate a hard
       dependency on Emscripten. This feature will be moved into a
       higher-level API or a runtime-configurable feature.

       That said, what its replacement should eventually do is...

       Exports a copy of this db's file as a Uint8Array and
       returns it. It is technically not legal to call this while
       any prepared statement are currently active because,
       depending on the platform, it might not be legal to read
       the db while a statement is locking it. Throws if this db
       is not open or has any opened statements.

       The resulting buffer can be passed to this class's
       constructor to restore the DB.

       Maintenance reminder: the corresponding sql.js impl of this
       feature closes the current db, finalizing any active
       statements and (seemingly unnecessarily) destroys any UDFs,
       copies the file, and then re-opens it (without restoring
       the UDFs). Those gymnastics are not necessary on the tested
       platform but might be necessary on others. Because of that
       eventuality, this interface currently enforces that no
       statements are active when this is run. It will throw if
       any are.
    */
    exportBinaryImage: function(){
      toss3("exportBinaryImage() is slated for removal for portability reasons.");
      /***********************
         The following is currently kept only for reference when
         porting to some other layer, noting that we may well not be
         able to implement this, at this level, when using the OPFS
         VFS because of its exclusive locking policy.

         affirmDbOpen(this);
         if(this.openStatementCount()>0){
           toss3("Cannot export with prepared statements active!",
                 "finalize() all statements and try again.");
         }
         return MODCFG.FS.readFile(this.filename, {encoding:"binary"});
      ***********************/
    }
  }/*DB.prototype*/;


  /** Throws if the given Stmt has been finalized, else stmt is
      returned. */
  const affirmStmtOpen = function(stmt){
    if(!stmt.pointer) toss3("Stmt has been closed.");
    return stmt;
  };

  /** Returns an opaque truthy value from the BindTypes
      enum if v's type is a valid bindable type, else
      returns a falsy value. As a special case, a value of
      undefined is treated as a bind type of null. */
  const isSupportedBindType = function(v){
    let t = BindTypes[(null===v||undefined===v) ? 'null' : typeof v];
    switch(t){
        case BindTypes.boolean:
        case BindTypes.null:
        case BindTypes.number:
        case BindTypes.string:
          return t;
        case BindTypes.bigint:
          if(capi.wasm.bigIntEnabled) return t;
          /* else fall through */
        default:
          //console.log("isSupportedBindType",t,v);
          return util.isBindableTypedArray(v) ? BindTypes.blob : undefined;
    }
  };

  /**
     If isSupportedBindType(v) returns a truthy value, this
     function returns that value, else it throws.
  */
  const affirmSupportedBindType = function(v){
    //console.log('affirmSupportedBindType',v);
    return isSupportedBindType(v) || toss3("Unsupported bind() argument type:",typeof v);
  };

  /**
     If key is a number and within range of stmt's bound parameter
     count, key is returned.

     If key is not a number then it is checked against named
     parameters. If a match is found, its index is returned.

     Else it throws.
  */
  const affirmParamIndex = function(stmt,key){
    const n = ('number'===typeof key)
          ? key : capi.sqlite3_bind_parameter_index(stmt.pointer, key);
    if(0===n || !util.isInt32(n)){
      toss3("Invalid bind() parameter name: "+key);
    }
    else if(n<1 || n>stmt.parameterCount) toss3("Bind index",key,"is out of range.");
    return n;
  };

  /**
     If stmt._isLocked is truthy, this throws an exception
     complaining that the 2nd argument (an operation name,
     e.g. "bind()") is not legal while the statement is "locked".
     Locking happens before an exec()-like callback is passed a
     statement, to ensure that the callback does not mutate or
     finalize the statement. If it does not throw, it returns stmt.
  */
  const affirmUnlocked = function(stmt,currentOpName){
    if(stmt._isLocked){
      toss3("Operation is illegal when statement is locked:",currentOpName);
    }
    return stmt;
  };

  /**
     Binds a single bound parameter value on the given stmt at the
     given index (numeric or named) using the given bindType (see
     the BindTypes enum) and value. Throws on error. Returns stmt on
     success.
  */
  const bindOne = function f(stmt,ndx,bindType,val){
    affirmUnlocked(stmt, 'bind()');
    if(!f._){
      if(capi.wasm.bigIntEnabled){
        f._maxInt = BigInt("0x7fffffffffffffff");
        f._minInt = ~f._maxInt;
      }
      /* Reminder: when not in BigInt mode, it's impossible for
         JS to represent a number out of the range we can bind,
         so we have no range checking. */
      f._ = {
        string: function(stmt, ndx, val, asBlob){
          if(1){
            /* _Hypothetically_ more efficient than the impl in the 'else' block. */
            const stack = capi.wasm.scopedAllocPush();
            try{
              const n = capi.wasm.jstrlen(val);
              const pStr = capi.wasm.scopedAlloc(n);
              capi.wasm.jstrcpy(val, capi.wasm.heap8u(), pStr, n, false);
              const f = asBlob ? capi.sqlite3_bind_blob : capi.sqlite3_bind_text;
              return f(stmt.pointer, ndx, pStr, n, capi.SQLITE_TRANSIENT);
            }finally{
              capi.wasm.scopedAllocPop(stack);
            }
          }else{
            const bytes = capi.wasm.jstrToUintArray(val,false);
            const pStr = capi.wasm.alloc(bytes.length || 1);
            capi.wasm.heap8u().set(bytes.length ? bytes : [0], pStr);
            try{
              const f = asBlob ? capi.sqlite3_bind_blob : capi.sqlite3_bind_text;
              return f(stmt.pointer, ndx, pStr, bytes.length, capi.SQLITE_TRANSIENT);
            }finally{
              capi.wasm.dealloc(pStr);
            }
          }
        }
      };
    }
    affirmSupportedBindType(val);
    ndx = affirmParamIndex(stmt,ndx);
    let rc = 0;
    switch((null===val || undefined===val) ? BindTypes.null : bindType){
        case BindTypes.null:
          rc = capi.sqlite3_bind_null(stmt.pointer, ndx);
          break;
        case BindTypes.string:
          rc = f._.string(stmt, ndx, val, false);
          break;
        case BindTypes.number: {
          let m;
          if(util.isInt32(val)) m = capi.sqlite3_bind_int;
          else if(capi.wasm.bigIntEnabled && ('bigint'===typeof val)){
            if(val<f._minInt || val>f._maxInt){
              toss3("BigInt value is out of range for int64: "+val);
            }
            m = capi.sqlite3_bind_int64;
          }else if(Number.isInteger(val)){
            m = capi.sqlite3_bind_int64;
          }else{
            m = capi.sqlite3_bind_double;
          }
          rc = m(stmt.pointer, ndx, val);
          break;
        }
        case BindTypes.boolean:
          rc = capi.sqlite3_bind_int(stmt.pointer, ndx, val ? 1 : 0);
          break;
        case BindTypes.blob: {
          if('string'===typeof val){
            rc = f._.string(stmt, ndx, val, true);
          }else if(!util.isBindableTypedArray(val)){
            toss3("Binding a value as a blob requires",
                  "that it be a string, Uint8Array, or Int8Array.");
          }else if(1){
            /* _Hypothetically_ more efficient than the impl in the 'else' block. */
            const stack = capi.wasm.scopedAllocPush();
            try{
              const pBlob = capi.wasm.scopedAlloc(val.byteLength || 1);
              capi.wasm.heap8().set(val.byteLength ? val : [0], pBlob)
              rc = capi.sqlite3_bind_blob(stmt.pointer, ndx, pBlob, val.byteLength,
                                         capi.SQLITE_TRANSIENT);
            }finally{
              capi.wasm.scopedAllocPop(stack);
            }
          }else{
            const pBlob = capi.wasm.mallocFromTypedArray(val);
            try{
              rc = capi.sqlite3_bind_blob(stmt.pointer, ndx, pBlob, val.byteLength,
                                         capi.SQLITE_TRANSIENT);
            }finally{
              capi.wasm.dealloc(pBlob);
            }
          }
          break;
        }
        default:
          console.warn("Unsupported bind() argument type:",val);
          toss3("Unsupported bind() argument type: "+(typeof val));
    }
    if(rc) checkDbRc(stmt.db.pointer, rc);
    return stmt;
  };

  Stmt.prototype = {
    /**
       "Finalizes" this statement. This is a no-op if the
       statement has already been finalizes. Returns
       undefined. Most methods in this class will throw if called
       after this is.
    */
    finalize: function(){
      if(this.pointer){
        affirmUnlocked(this,'finalize()');
        delete __stmtMap.get(this.db)[this.pointer];
        capi.sqlite3_finalize(this.pointer);
        __ptrMap.delete(this);
        delete this.columnCount;
        delete this.parameterCount;
        delete this.db;
        delete this._isLocked;
      }
    },
    /** Clears all bound values. Returns this object.
        Throws if this statement has been finalized. */
    clearBindings: function(){
      affirmUnlocked(affirmStmtOpen(this), 'clearBindings()')
      capi.sqlite3_clear_bindings(this.pointer);
      this._mayGet = false;
      return this;
    },
    /**
       Resets this statement so that it may be step()ed again
       from the beginning. Returns this object. Throws if this
       statement has been finalized.

       If passed a truthy argument then this.clearBindings() is
       also called, otherwise any existing bindings, along with
       any memory allocated for them, are retained.
    */
    reset: function(alsoClearBinds){
      affirmUnlocked(this,'reset()');
      if(alsoClearBinds) this.clearBindings();
      capi.sqlite3_reset(affirmStmtOpen(this).pointer);
      this._mayGet = false;
      return this;
    },
    /**
       Binds one or more values to its bindable parameters. It
       accepts 1 or 2 arguments:

       If passed a single argument, it must be either an array, an
       object, or a value of a bindable type (see below).

       If passed 2 arguments, the first one is the 1-based bind
       index or bindable parameter name and the second one must be
       a value of a bindable type.

       Bindable value types:

       - null is bound as NULL.

       - undefined as a standalone value is a no-op intended to
       simplify certain client-side use cases: passing undefined
       as a value to this function will not actually bind
       anything and this function will skip confirmation that
       binding is even legal. (Those semantics simplify certain
       client-side uses.) Conversely, a value of undefined as an
       array or object property when binding an array/object
       (see below) is treated the same as null.

       - Numbers are bound as either doubles or integers: doubles
       if they are larger than 32 bits, else double or int32,
       depending on whether they have a fractional part. (It is,
       as of this writing, illegal to call (from JS) a WASM
       function which either takes or returns an int64.)
       Booleans are bound as integer 0 or 1. It is not expected
       the distinction of binding doubles which have no
       fractional parts is integers is significant for the
       majority of clients due to sqlite3's data typing
       model. If capi.wasm.bigIntEnabled is true then this
       routine will bind BigInt values as 64-bit integers.

       - Strings are bound as strings (use bindAsBlob() to force
       blob binding).

       - Uint8Array and Int8Array instances are bound as blobs.
       (TODO: binding the other TypedArray types.)

       If passed an array, each element of the array is bound at
       the parameter index equal to the array index plus 1
       (because arrays are 0-based but binding is 1-based).

       If passed an object, each object key is treated as a
       bindable parameter name. The object keys _must_ match any
       bindable parameter names, including any `$`, `@`, or `:`
       prefix. Because `$` is a legal identifier chararacter in
       JavaScript, that is the suggested prefix for bindable
       parameters: `stmt.bind({$a: 1, $b: 2})`.

       It returns this object on success and throws on
       error. Errors include:

       - Any bind index is out of range, a named bind parameter
       does not match, or this statement has no bindable
       parameters.

       - Any value to bind is of an unsupported type.

       - Passed no arguments or more than two.

       - The statement has been finalized.
    */
    bind: function(/*[ndx,] arg*/){
      affirmStmtOpen(this);
      let ndx, arg;
      switch(arguments.length){
          case 1: ndx = 1; arg = arguments[0]; break;
          case 2: ndx = arguments[0]; arg = arguments[1]; break;
          default: toss3("Invalid bind() arguments.");
      }
      if(undefined===arg){
        /* It might seem intuitive to bind undefined as NULL
           but this approach simplifies certain client-side
           uses when passing on arguments between 2+ levels of
           functions. */
        return this;
      }else if(!this.parameterCount){
        toss3("This statement has no bindable parameters.");
      }
      this._mayGet = false;
      if(null===arg){
        /* bind NULL */
        return bindOne(this, ndx, BindTypes.null, arg);
      }
      else if(Array.isArray(arg)){
        /* bind each entry by index */
        if(1!==arguments.length){
          toss3("When binding an array, an index argument is not permitted.");
        }
        arg.forEach((v,i)=>bindOne(this, i+1, affirmSupportedBindType(v), v));
        return this;
      }
      else if('object'===typeof arg/*null was checked above*/
              && !util.isBindableTypedArray(arg)){
        /* Treat each property of arg as a named bound parameter. */
        if(1!==arguments.length){
          toss3("When binding an object, an index argument is not permitted.");
        }
        Object.keys(arg)
          .forEach(k=>bindOne(this, k,
                              affirmSupportedBindType(arg[k]),
                              arg[k]));
        return this;
      }else{
        return bindOne(this, ndx, affirmSupportedBindType(arg), arg);
      }
      toss3("Should not reach this point.");
    },
    /**
       Special case of bind() which binds the given value using the
       BLOB binding mechanism instead of the default selected one for
       the value. The ndx may be a numbered or named bind index. The
       value must be of type string, null/undefined (both get treated
       as null), or a TypedArray of a type supported by the bind()
       API.

       If passed a single argument, a bind index of 1 is assumed and
       the first argument is the value.
    */
    bindAsBlob: function(ndx,arg){
      affirmStmtOpen(this);
      if(1===arguments.length){
        arg = ndx;
        ndx = 1;
      }
      const t = affirmSupportedBindType(arg);
      if(BindTypes.string !== t && BindTypes.blob !== t
         && BindTypes.null !== t){
        toss3("Invalid value type for bindAsBlob()");
      }
      bindOne(this, ndx, BindTypes.blob, arg);
      this._mayGet = false;
      return this;
    },
    /**
       Steps the statement one time. If the result indicates that
       a row of data is available, true is returned.  If no row of
       data is available, false is returned.  Throws on error.
    */
    step: function(){
      affirmUnlocked(this, 'step()');
      const rc = capi.sqlite3_step(affirmStmtOpen(this).pointer);
      switch(rc){
          case capi.SQLITE_DONE: return this._mayGet = false;
          case capi.SQLITE_ROW: return this._mayGet = true;
          default:
            this._mayGet = false;
            console.warn("sqlite3_step() rc=",rc,"SQL =",
                         capi.sqlite3_sql(this.pointer));
            checkDbRc(this.db.pointer, rc);
      };
    },
    /**
       Fetches the value from the given 0-based column index of
       the current data row, throwing if index is out of range. 

       Requires that step() has just returned a truthy value, else
       an exception is thrown.

       By default it will determine the data type of the result
       automatically. If passed a second arugment, it must be one
       of the enumeration values for sqlite3 types, which are
       defined as members of the sqlite3 module: SQLITE_INTEGER,
       SQLITE_FLOAT, SQLITE_TEXT, SQLITE_BLOB. Any other value,
       except for undefined, will trigger an exception. Passing
       undefined is the same as not passing a value. It is legal
       to, e.g., fetch an integer value as a string, in which case
       sqlite3 will convert the value to a string.

       If ndx is an array, this function behaves a differently: it
       assigns the indexes of the array, from 0 to the number of
       result columns, to the values of the corresponding column,
       and returns that array.

       If ndx is a plain object, this function behaves even
       differentlier: it assigns the properties of the object to
       the values of their corresponding result columns.

       Blobs are returned as Uint8Array instances.

       Potential TODO: add type ID SQLITE_JSON, which fetches the
       result as a string and passes it (if it's not null) to
       JSON.parse(), returning the result of that. Until then,
       getJSON() can be used for that.
    */
    get: function(ndx,asType){
      if(!affirmStmtOpen(this)._mayGet){
        toss3("Stmt.step() has not (recently) returned true.");
      }
      if(Array.isArray(ndx)){
        let i = 0;
        while(i<this.columnCount){
          ndx[i] = this.get(i++);
        }
        return ndx;
      }else if(ndx && 'object'===typeof ndx){
        let i = 0;
        while(i<this.columnCount){
          ndx[capi.sqlite3_column_name(this.pointer,i)] = this.get(i++);
        }
        return ndx;
      }
      affirmColIndex(this, ndx);
      switch(undefined===asType
             ? capi.sqlite3_column_type(this.pointer, ndx)
             : asType){
          case capi.SQLITE_NULL: return null;
          case capi.SQLITE_INTEGER:{
            if(capi.wasm.bigIntEnabled){
              const rc = capi.sqlite3_column_int64(this.pointer, ndx);
              if(rc>=Number.MIN_SAFE_INTEGER && rc<=Number.MAX_SAFE_INTEGER){
                /* Coerce "normal" number ranges to normal number values,
                   and only return BigInt-type values for numbers out of this
                   range. */
                return Number(rc).valueOf();
              }
              return rc;
            }else{
              const rc = capi.sqlite3_column_double(this.pointer, ndx);
              if(rc>Number.MAX_SAFE_INTEGER || rc<Number.MIN_SAFE_INTEGER){
                /* Throwing here is arguable but, since we're explicitly
                   extracting an SQLITE_INTEGER-type value, it seems fair to throw
                   if the extracted number is out of range for that type.
                   This policy may be laxened to simply pass on the number and
                   hope for the best, as the C API would do. */
                toss3("Integer is out of range for JS integer range: "+rc);
              }
              //console.log("get integer rc=",rc,isInt32(rc));
              return util.isInt32(rc) ? (rc | 0) : rc;
            }
          }
          case capi.SQLITE_FLOAT:
            return capi.sqlite3_column_double(this.pointer, ndx);
          case capi.SQLITE_TEXT:
            return capi.sqlite3_column_text(this.pointer, ndx);
          case capi.SQLITE_BLOB: {
            const n = capi.sqlite3_column_bytes(this.pointer, ndx),
                  ptr = capi.sqlite3_column_blob(this.pointer, ndx),
                  rc = new Uint8Array(n);
            //heap = n ? capi.wasm.heap8() : false;
            if(n) rc.set(capi.wasm.heap8u().slice(ptr, ptr+n), 0);
            //for(let i = 0; i < n; ++i) rc[i] = heap[ptr + i];
            if(n && this.db._blobXfer instanceof Array){
              /* This is an optimization soley for the
                 Worker-based API. These values will be
                 transfered to the main thread directly
                 instead of being copied. */
              this.db._blobXfer.push(rc.buffer);
            }
            return rc;
          }
          default: toss3("Don't know how to translate",
                         "type of result column #"+ndx+".");
      }
      abort("Not reached.");
    },
    /** Equivalent to get(ndx) but coerces the result to an
        integer. */
    getInt: function(ndx){return this.get(ndx,capi.SQLITE_INTEGER)},
    /** Equivalent to get(ndx) but coerces the result to a
        float. */
    getFloat: function(ndx){return this.get(ndx,capi.SQLITE_FLOAT)},
    /** Equivalent to get(ndx) but coerces the result to a
        string. */
    getString: function(ndx){return this.get(ndx,capi.SQLITE_TEXT)},
    /** Equivalent to get(ndx) but coerces the result to a
        Uint8Array. */
    getBlob: function(ndx){return this.get(ndx,capi.SQLITE_BLOB)},
    /**
       A convenience wrapper around get() which fetches the value
       as a string and then, if it is not null, passes it to
       JSON.parse(), returning that result. Throws if parsing
       fails. If the result is null, null is returned. An empty
       string, on the other hand, will trigger an exception.
    */
    getJSON: function(ndx){
      const s = this.get(ndx, capi.SQLITE_STRING);
      return null===s ? s : JSON.parse(s);
    },
    // Design note: the only reason most of these getters have a 'get'
    // prefix is for consistency with getVALUE_TYPE().  The latter
    // arguablly really need that prefix for API readability and the
    // rest arguably don't, but consistency is a powerful thing.
    /**
       Returns the result column name of the given index, or
       throws if index is out of bounds or this statement has been
       finalized. This can be used without having run step()
       first.
    */
    getColumnName: function(ndx){
      return capi.sqlite3_column_name(
        affirmColIndex(affirmStmtOpen(this),ndx).pointer, ndx
      );
    },
    /**
       If this statement potentially has result columns, this
       function returns an array of all such names. If passed an
       array, it is used as the target and all names are appended
       to it. Returns the target array. Throws if this statement
       cannot have result columns. This object's columnCount member
       holds the number of columns.
    */
    getColumnNames: function(tgt){
      affirmColIndex(affirmStmtOpen(this),0);
      if(!tgt) tgt = [];
      for(let i = 0; i < this.columnCount; ++i){
        tgt.push(capi.sqlite3_column_name(this.pointer, i));
      }
      return tgt;
    },
    /**
       If this statement has named bindable parameters and the
       given name matches one, its 1-based bind index is
       returned. If no match is found, 0 is returned. If it has no
       bindable parameters, the undefined value is returned.
    */
    getParamIndex: function(name){
      return (affirmStmtOpen(this).parameterCount
              ? capi.sqlite3_bind_parameter_index(this.pointer, name)
              : undefined);
    }
  }/*Stmt.prototype*/;

  {/* Add the `pointer` property to DB and Stmt. */
    const prop = {
      enumerable: true,
      get: function(){return __ptrMap.get(this)},
      set: ()=>toss3("The pointer property is read-only.")
    }
    Object.defineProperty(Stmt.prototype, 'pointer', prop);
    Object.defineProperty(DB.prototype, 'pointer', prop);
  }
  
  /** The OO API's public namespace. */
  sqlite3.oo1 = {
    version: {
      lib: capi.sqlite3_libversion(),
      ooApi: "0.1"
    },
    DB,
    Stmt
  }/*SQLite3 object*/;
})(self);
/* END FILE: api/sqlite3-api-oo1.js */
/* BEGIN FILE: api/sqlite3-api-worker.js */
/*
  2022-07-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file implements a Worker-based wrapper around SQLite3 OO API
  #1.

  In order to permit this API to be loaded in worker threads without
  automatically registering onmessage handlers, initializing the
  worker API requires calling initWorkerAPI(). If this function
  is called from a non-worker thread then it throws an exception.

  When initialized, it installs message listeners to receive messages
  from the main thread and then it posts a message in the form:

  ```
  {type:'sqlite3-api',data:'worker-ready'}
  ```

  This file requires that the core C-style sqlite3 API and OO API #1
  have been loaded and that self.sqlite3 contains both,
  as documented for those APIs.
*/
self.sqlite3.initWorkerAPI = function(){
  'use strict';
  /**
     UNDER CONSTRUCTION

     We need an API which can proxy the DB API via a Worker message
     interface. The primary quirky factor in such an API is that we
     cannot pass callback functions between the window thread and a
     worker thread, so we have to receive all db results via
     asynchronous message-passing. That requires an asychronous API
     with a distinctly different shape that the main OO API.

     Certain important considerations here include:

     - Support only one db connection or multiple? The former is far
     easier, but there's always going to be a user out there who wants
     to juggle six database handles at once. Do we add that complexity
     or tell such users to write their own code using the provided
     lower-level APIs?

     - Fetching multiple results: do we pass them on as a series of
     messages, with start/end messages on either end, or do we collect
     all results and bundle them back in a single message?  The former
     is, generically speaking, more memory-efficient but the latter
     far easier to implement in this environment. The latter is
     untennable for large data sets. Despite a web page hypothetically
     being a relatively limited environment, there will always be
     those users who feel that they should/need to be able to work
     with multi-hundred-meg (or larger) blobs, and passing around
     arrays of those may quickly exhaust the JS engine's memory.

     TODOs include, but are not limited to:

     - The ability to manage multiple DB handles. This can
     potentially be done via a simple mapping of DB.filename or
     DB.pointer (`sqlite3*` handle) to DB objects. The open()
     interface would need to provide an ID (probably DB.pointer) back
     to the user which can optionally be passed as an argument to
     the other APIs (they'd default to the first-opened DB, for
     ease of use). Client-side usability of this feature would
     benefit from making another wrapper class (or a singleton)
     available to the main thread, with that object proxying all(?)
     communication with the worker.

     - Revisit how virtual files are managed. We currently delete DBs
     from the virtual filesystem when we close them, for the sake of
     saving memory (the VFS lives in RAM). Supporting multiple DBs may
     require that we give up that habit. Similarly, fully supporting
     ATTACH, where a user can upload multiple DBs and ATTACH them,
     also requires the that we manage the VFS entries better.
  */
  const toss = (...args)=>{throw new Error(args.join(' '))};
  if('function' !== typeof importScripts){
    toss("Cannot initalize the sqlite3 worker API in the main thread.");
  }
  const self = this.self;
  const sqlite3 = this.sqlite3 || toss("Missing this.sqlite3 object.");
  const SQLite3 = sqlite3.oo1 || toss("Missing this.sqlite3.oo1 OO API.");
  const DB = SQLite3.DB;

  /**
     Returns the app-wide unique ID for the given db, creating one if
     needed.
  */
  const getDbId = function(db){
    let id = wState.idMap.get(db);
    if(id) return id;
    id = 'db#'+(++wState.idSeq)+'@'+db.pointer;
    /** ^^^ can't simply use db.pointer b/c closing/opening may re-use
        the same address, which could map pending messages to a wrong
        instance. */
    wState.idMap.set(db, id);
    return id;
  };

  /**
     Helper for managing Worker-level state.
  */
  const wState = {
    defaultDb: undefined,
    idSeq: 0,
    idMap: new WeakMap,
    open: function(arg){
      // TODO: if arg is a filename, look for a db in this.dbs with the
      // same filename and close/reopen it (or just pass it back as is?).
      if(!arg && this.defaultDb) return this.defaultDb;
      //???if(this.defaultDb) this.defaultDb.close();
      let db;
      db = (Array.isArray(arg) ? new DB(...arg) : new DB(arg));
      this.dbs[getDbId(db)] = db;
      if(!this.defaultDb) this.defaultDb = db;
      return db;
    },
    close: function(db,alsoUnlink){
      if(db){
        delete this.dbs[getDbId(db)];
        db.close(alsoUnlink);
        if(db===this.defaultDb) this.defaultDb = undefined;
      }
    },
    post: function(type,data,xferList){
      if(xferList){
        self.postMessage({type, data},xferList);
        xferList.length = 0;
      }else{
        self.postMessage({type, data});
      }
    },
    /** Map of DB IDs to DBs. */
    dbs: Object.create(null),
    getDb: function(id,require=true){
      return this.dbs[id]
        || (require ? toss("Unknown (or closed) DB ID:",id) : undefined);
    }
  };

  /** Throws if the given db is falsy or not opened. */
  const affirmDbOpen = function(db = wState.defaultDb){
    return (db && db.pointer) ? db : toss("DB is not opened.");
  };

  /** Extract dbId from the given message payload. */
  const getMsgDb = function(msgData,affirmExists=true){
    const db = wState.getDb(msgData.dbId,false) || wState.defaultDb;
    return affirmExists ? affirmDbOpen(db) : db;
  };

  const getDefaultDbId = function(){
    return wState.defaultDb && getDbId(wState.defaultDb);
  };

  /**
     A level of "organizational abstraction" for the Worker
     API. Each method in this object must map directly to a Worker
     message type key. The onmessage() dispatcher attempts to
     dispatch all inbound messages to a method of this object,
     passing it the event.data part of the inbound event object. All
     methods must return a plain Object containing any response
     state, which the dispatcher may amend. All methods must throw
     on error.
  */
  const wMsgHandler = {
    xfer: [/*Temp holder for "transferable" postMessage() state.*/],
    /**
       Proxy for DB.exec() which expects a single argument of type
       string (SQL to execute) or an options object in the form
       expected by exec(). The notable differences from exec()
       include:

       - The default value for options.rowMode is 'array' because
       the normal default cannot cross the window/Worker boundary.

       - A function-type options.callback property cannot cross
       the window/Worker boundary, so is not useful here. If
       options.callback is a string then it is assumed to be a
       message type key, in which case a callback function will be
       applied which posts each row result via:

       postMessage({type: thatKeyType, data: theRow})

       And, at the end of the result set (whether or not any
       result rows were produced), it will post an identical
       message with data:null to alert the caller than the result
       set is completed.

       The callback proxy must not recurse into this interface, or
       results are undefined. (It hypothetically cannot recurse
       because an exec() call will be tying up the Worker thread,
       causing any recursion attempt to wait until the first
       exec() is completed.)

       The response is the input options object (or a synthesized
       one if passed only a string), noting that
       options.resultRows and options.columnNames may be populated
       by the call to exec().

       This opens/creates the Worker's db if needed.
    */
    exec: function(ev){
      const opt = (
        'string'===typeof ev.data
      ) ? {sql: ev.data} : (ev.data || Object.create(null));
      if(undefined===opt.rowMode){
        /* Since the default rowMode of 'stmt' is not useful
           for the Worker interface, we'll default to
           something else. */
        opt.rowMode = 'array';
      }else if('stmt'===opt.rowMode){
        toss("Invalid rowMode for exec(): stmt mode",
             "does not work in the Worker API.");
      }
      const db = getMsgDb(ev);
      if(opt.callback || Array.isArray(opt.resultRows)){
        // Part of a copy-avoidance optimization for blobs
        db._blobXfer = this.xfer;
      }
      const callbackMsgType = opt.callback;
      if('string' === typeof callbackMsgType){
        /* Treat this as a worker message type and post each
           row as a message of that type. */
        const that = this;
        opt.callback =
          (row)=>wState.post(callbackMsgType,row,this.xfer);
      }
      try {
        db.exec(opt);
        if(opt.callback instanceof Function){
          opt.callback = callbackMsgType;
          wState.post(callbackMsgType, null);
        }
      }/*catch(e){
         console.warn("Worker is propagating:",e);throw e;
         }*/finally{
           delete db._blobXfer;
           if(opt.callback){
             opt.callback = callbackMsgType;
           }
         }
      return opt;
    }/*exec()*/,
    /**
       TO(re)DO, once we can abstract away access to the
       JS environment's virtual filesystem. Currently this
       always throws.

       Response is (should be) an object:

       {
         buffer: Uint8Array (db file contents),
         filename: the current db filename,
         mimetype: 'application/x-sqlite3'
       }

       TODO is to determine how/whether this feature can support
       exports of ":memory:" and "" (temp file) DBs. The latter is
       ostensibly easy because the file is (potentially) on disk, but
       the former does not have a structure which maps directly to a
       db file image.
    */
    export: function(ev){
      toss("export() requires reimplementing for portability reasons.");
      /**const db = getMsgDb(ev);
      const response = {
        buffer: db.exportBinaryImage(),
        filename: db.filename,
        mimetype: 'application/x-sqlite3'
      };
      this.xfer.push(response.buffer.buffer);
      return response;**/
    }/*export()*/,
    /**
       Proxy for the DB constructor. Expects to be passed a single
       object or a falsy value to use defaults. The object may
       have a filename property to name the db file (see the DB
       constructor for peculiarities and transformations) and/or a
       buffer property (a Uint8Array holding a complete database
       file's contents). The response is an object:

       {
         filename: db filename (possibly differing from the input),

         id: an opaque ID value intended for future distinction
             between multiple db handles. Messages including a specific
             ID will use the DB for that ID.

       }

       If the Worker's db is currently opened, this call closes it
       before proceeding.
    */
    open: function(ev){
      wState.close(/*true???*/);
      const args = [], data = (ev.data || {});
      if(data.simulateError){
        toss("Throwing because of open.simulateError flag.");
      }
      if(data.filename) args.push(data.filename);
      if(data.buffer){
        args.push(data.buffer);
        this.xfer.push(data.buffer.buffer);
      }
      const db = wState.open(args);
      return {
        filename: db.filename,
        dbId: getDbId(db)
      };
    },
    /**
       Proxy for DB.close(). If ev.data may either be a boolean or
       an object with an `unlink` property. If that value is
       truthy then the db file (if the db is currently open) will
       be unlinked from the virtual filesystem, else it will be
       kept intact. The response object is:

       {
         filename: db filename _if_ the db is opened when this
                   is called, else the undefined value
       }
    */
    close: function(ev){
      const db = getMsgDb(ev,false);
      const response = {
        filename: db && db.filename
      };
      if(db){
        wState.close(db, !!((ev.data && 'object'===typeof ev.data)
                            ? ev.data.unlink : ev.data));
      }
      return response;
    },
    toss: function(ev){
      toss("Testing worker exception");
    }
  }/*wMsgHandler*/;

  /**
     UNDER CONSTRUCTION!

     A subset of the DB API is accessible via Worker messages in the
     form:

     { type: apiCommand,
       dbId: optional DB ID value (else uses a default db handle)
       data: apiArguments
     }

     As a rule, these commands respond with a postMessage() of their
     own in the same form, but will, if needed, transform the `data`
     member to an object and may add state to it. The responses
     always have an object-format `data` part. If the inbound `data`
     is an object which has a `messageId` property, that property is
     always mirrored in the result object, for use in client-side
     dispatching of these asynchronous results. Exceptions thrown
     during processing result in an `error`-type event with a
     payload in the form:

     {
       message: error string,
       errorClass: class name of the error type,
       dbId: DB handle ID,
       input: ev.data,
       [messageId: if set in the inbound message]
     }

     The individual APIs are documented in the wMsgHandler object.
  */
  self.onmessage = function(ev){
    ev = ev.data;
    let response, dbId = ev.dbId, evType = ev.type;
    const arrivalTime = performance.now();
    try {
      if(wMsgHandler.hasOwnProperty(evType) &&
         wMsgHandler[evType] instanceof Function){
        response = wMsgHandler[evType](ev);
      }else{
        toss("Unknown db worker message type:",ev.type);
      }
    }catch(err){
      evType = 'error';
      response = {
        message: err.message,
        errorClass: err.name,
        input: ev
      };
      if(err.stack){
        response.stack = ('string'===typeof err.stack)
          ? err.stack.split('\n') : err.stack;
      }
      if(0) console.warn("Worker is propagating an exception to main thread.",
                         "Reporting it _here_ for the stack trace:",err,response);
    }
    if(!response.messageId && ev.data
       && 'object'===typeof ev.data && ev.data.messageId){
      response.messageId = ev.data.messageId;
    }
    if(!dbId){
      dbId = response.dbId/*from 'open' cmd*/
        || getDefaultDbId();
    }
    if(!response.dbId) response.dbId = dbId;
    // Timing info is primarily for use in testing this API. It's not part of
    // the public API. arrivalTime = when the worker got the message.
    response.workerReceivedTime = arrivalTime;
    response.workerRespondTime = performance.now();
    response.departureTime = ev.departureTime;
    wState.post(evType, response, wMsgHandler.xfer);
  };
  setTimeout(()=>self.postMessage({type:'sqlite3-api',data:'worker-ready'}), 0);
}.bind({self, sqlite3: self.sqlite3});
/* END FILE: api/sqlite3-api-worker.js */
/* BEGIN FILE: api/sqlite3-api-opfs.js */
/*
  2022-07-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file contains extensions to the sqlite3 WASM API related to the
  Origin-Private FileSystem (OPFS). It is intended to be appended to
  the main JS deliverable somewhere after sqlite3-api-glue.js and
  before sqlite3-api-cleanup.js.

  Significant notes and limitations:

  - As of this writing, OPFS is still very much in flux and only
    available in bleeding-edge versions of Chrome (v102+, noting that
    that number will increase as the OPFS API matures).

  - The _synchronous_ family of OPFS features (which is what this API
    requires) are only available in non-shared Worker threads. This
    file tries to detect that case and becomes a no-op if those
    features do not seem to be available.
*/

// FileSystemHandle
// FileSystemDirectoryHandle
// FileSystemFileHandle
// FileSystemFileHandle.prototype.createSyncAccessHandle
self.sqlite3.postInit.push(function(self, sqlite3){
  const warn = console.warn.bind(console),
        error = console.error.bind(console);
  if(!self.importScripts || !self.FileSystemFileHandle
     || !self.FileSystemFileHandle.prototype.createSyncAccessHandle){
    warn("OPFS not found or its sync API is not available in this environment.");
    return;
  }else if(!sqlite3.capi.wasm.bigIntEnabled){
    error("OPFS requires BigInt support but sqlite3.capi.wasm.bigIntEnabled is false.");
    return;
  }
  //warn('self.FileSystemFileHandle =',self.FileSystemFileHandle);
  //warn('self.FileSystemFileHandle.prototype =',self.FileSystemFileHandle.prototype);
  const toss = (...args)=>{throw new Error(args.join(' '))};
  const capi = sqlite3.capi,
        wasm = capi.wasm;
  const sqlite3_vfs = capi.sqlite3_vfs
        || toss("Missing sqlite3.capi.sqlite3_vfs object.");
  const sqlite3_file = capi.sqlite3_file
        || toss("Missing sqlite3.capi.sqlite3_file object.");
  const sqlite3_io_methods = capi.sqlite3_io_methods
        || toss("Missing sqlite3.capi.sqlite3_io_methods object.");
  const StructBinder = sqlite3.StructBinder || toss("Missing sqlite3.StructBinder.");
  const debug = console.debug.bind(console),
        log = console.log.bind(console);
  warn("UNDER CONSTRUCTION: setting up OPFS VFS...");

  const pDVfs = capi.sqlite3_vfs_find(null)/*pointer to default VFS*/;
  const dVfs = pDVfs
        ? new sqlite3_vfs(pDVfs)
        : null /* dVfs will be null when sqlite3 is built with
                  SQLITE_OS_OTHER. Though we cannot currently handle
                  that case, the hope is to eventually be able to. */;
  const oVfs = new sqlite3_vfs();
  const oIom = new sqlite3_io_methods();
  oVfs.$iVersion = 2/*yes, two*/;
  oVfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  oVfs.$mxPathname = 1024/*sure, why not?*/;
  oVfs.$zName = wasm.allocCString("opfs");
  oVfs.ondispose = [
    '$zName', oVfs.$zName,
    'cleanup dVfs', ()=>(dVfs ? dVfs.dispose() : null)
  ];
  if(dVfs){
    oVfs.$xSleep = dVfs.$xSleep;
    oVfs.$xRandomness = dVfs.$xRandomness;
  }
  // All C-side memory of oVfs is zeroed out, but just to be explicit:
  oVfs.$xDlOpen = oVfs.$xDlError = oVfs.$xDlSym = oVfs.$xDlClose = null;

  /**
     Pedantic sidebar about oVfs.ondispose: the entries in that array
     are items to clean up when oVfs.dispose() is called, but in this
     environment it will never be called. The VFS instance simply
     hangs around until the WASM module instance is cleaned up. We
     "could" _hypothetically_ clean it up by "importing" an
     sqlite3_os_end() impl into the wasm build, but the shutdown order
     of the wasm engine and the JS one are undefined so there is no
     guaranty that the oVfs instance would be available in one
     environment or the other when sqlite3_os_end() is called (_if_ it
     gets called at all in a wasm build, which is undefined).
  */

  /**
     Installs a StructBinder-bound function pointer member of the
     given name and function in the given StructType target object.
     It creates a WASM proxy for the given function and arranges for
     that proxy to be cleaned up when tgt.dispose() is called.  Throws
     on the slightest hint of error (e.g. tgt is-not-a StructType,
     name does not map to a struct-bound member, etc.).

     Returns a proxy for this function which is bound to tgt and takes
     2 args (name,func). That function returns the same thing,
     permitting calls to be chained.

     If called with only 1 arg, it has no side effects but returns a
     func with the same signature as described above.
  */
  const installMethod = function callee(tgt, name, func){
    if(!(tgt instanceof StructBinder.StructType)){
      toss("Usage error: target object is-not-a StructType.");
    }
    if(1===arguments.length){
      return (n,f)=>callee(tgt,n,f);
    }
    if(!callee.argcProxy){
      callee.argcProxy = function(func,sig){
        return function(...args){
          if(func.length!==arguments.length){
            toss("Argument mismatch. Native signature is:",sig);
          }
          return func.apply(this, args);
        }
      };
      callee.removeFuncList = function(){
        if(this.ondispose.__removeFuncList){
          this.ondispose.__removeFuncList.forEach(
            (v,ndx)=>{
              if('number'===typeof v){
                try{wasm.uninstallFunction(v)}
                catch(e){/*ignore*/}
              }
              /* else it's a descriptive label for the next number in
                 the list. */
            }
          );
          delete this.ondispose.__removeFuncList;
        }
      };
    }/*static init*/
    const sigN = tgt.memberSignature(name);
    if(sigN.length<2){
      toss("Member",name," is not a function pointer. Signature =",sigN);
    }
    const memKey = tgt.memberKey(name);
    //log("installMethod",tgt, name, sigN);
    const fProxy = 1
          // We can remove this proxy middle-man once the VFS is working
          ? callee.argcProxy(func, sigN)
          : func;
    const pFunc = wasm.installFunction(fProxy, tgt.memberSignature(name, true));
    tgt[memKey] = pFunc;
    if(!tgt.ondispose) tgt.ondispose = [];
    if(!tgt.ondispose.__removeFuncList){
      tgt.ondispose.push('ondispose.__removeFuncList handler',
                         callee.removeFuncList);
      tgt.ondispose.__removeFuncList = [];
    }
    tgt.ondispose.__removeFuncList.push(memKey, pFunc);
    return (n,f)=>callee(tgt, n, f);
  }/*installMethod*/;

  /**
     Map of sqlite3_file pointers to OPFS handles.
  */
  const __opfsHandles = Object.create(null);

  const randomFilename = function f(len=16){
    if(!f._chars){
      f._chars = "abcdefghijklmnopqrstuvwxyz"+
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"+
        "012346789";
      f._n = f._chars.length;
    }
    const a = [];
    let i = 0;
    for( ; i < len; ++i){
      const ndx = Math.random() * (f._n * 64) % f._n | 0;
      a[i] = f._chars[ndx];
    }
    return a.join('');
  };

  //const rootDir = await navigator.storage.getDirectory();
  
  ////////////////////////////////////////////////////////////////////////
  // Set up OPFS VFS methods...
  let inst = installMethod(oVfs);
  inst('xOpen', function(pVfs, zName, pFile, flags, pOutFlags){
    const f = new sqlite3_file(pFile);
    f.$pMethods = oIom.pointer;
    __opfsHandles[pFile] = f;
    f.opfsHandle = null /* TODO */;
    if(flags & capi.SQLITE_OPEN_DELETEONCLOSE){
      f.deleteOnClose = true;
    }
    f.filename = zName ? wasm.cstringToJs(zName) : randomFilename();
    error("OPFS sqlite3_vfs::xOpen is not yet full implemented.");
    return capi.SQLITE_IOERR;
  })
  ('xFullPathname', function(pVfs,zName,nOut,pOut){
    /* Until/unless we have some notion of "current dir"
       in OPFS, simply copy zName to pOut... */
    const i = wasm.cstrncpy(pOut, zName, nOut);
    return i<nOut ? 0 : capi.SQLITE_CANTOPEN
    /*CANTOPEN is required by the docs but SQLITE_RANGE would be a closer match*/;
  })
  ('xAccess', function(pVfs,zName,flags,pOut){
    error("OPFS sqlite3_vfs::xAccess is not yet implemented.");
    let fileExists = 0;
    switch(flags){
        case capi.SQLITE_ACCESS_EXISTS: break;
        case capi.SQLITE_ACCESS_READWRITE: break;
        case capi.SQLITE_ACCESS_READ/*docs say this is never used*/:
        default:
          error("Unexpected flags value for sqlite3_vfs::xAccess():",flags);
          return capi.SQLITE_MISUSE;
    }
    wasm.setMemValue(pOut, fileExists, 'i32');
    return 0;
  })
  ('xDelete', function(pVfs, zName, doSyncDir){
    error("OPFS sqlite3_vfs::xDelete is not yet implemented.");
    return capi.SQLITE_IOERR;
  })
  ('xGetLastError', function(pVfs,nOut,pOut){
    debug("OPFS sqlite3_vfs::xGetLastError() has nothing sensible to return.");
    return 0;
  })
  ('xCurrentTime', function(pVfs,pOut){
    /* If it turns out that we need to adjust for timezone, see:
       https://stackoverflow.com/a/11760121/1458521 */
    wasm.setMemValue(pOut, 2440587.5 + (new Date().getTime()/86400000),
                     'double');
    return 0;
  })
  ('xCurrentTimeInt64',function(pVfs,pOut){
    // TODO: confirm that this calculation is correct
    wasm.setMemValue(pOut, (2440587.5 * 86400000) + new Date().getTime(),
                     'i64');
    return 0;
  });
  if(!oVfs.$xSleep){
    inst('xSleep', function(pVfs,ms){
      error("sqlite3_vfs::xSleep(",ms,") cannot be implemented from "+
           "JS and we have no default VFS to copy the impl from.");
      return 0;
    });
  }
  if(!oVfs.$xRandomness){
    inst('xRandomness', function(pVfs, nOut, pOut){
      const heap = wasm.heap8u();
      let i = 0;
      for(; i < nOut; ++i) heap[pOut + i] = (Math.random()*255000) & 0xFF;
      return i;
    });
  }

  ////////////////////////////////////////////////////////////////////////
  // Set up OPFS sqlite3_io_methods...
  inst = installMethod(oIom);
  inst('xClose', async function(pFile){
    warn("xClose(",arguments,") uses await");
    const f = __opfsHandles[pFile];
    delete __opfsHandles[pFile];
    if(f.opfsHandle){
      await f.opfsHandle.close();
      if(f.deleteOnClose){
        // TODO
      }
    }
    f.dispose();
    return 0;
  })
  ('xRead', /*i(ppij)*/function(pFile,pDest,n,offset){
    /* int (*xRead)(sqlite3_file*, void*, int iAmt, sqlite3_int64 iOfst) */
    try {
      const f = __opfsHandles[pFile];
      const heap = wasm.heap8u();
      const b = new Uint8Array(heap.buffer, pDest, n);
      const nRead = f.opfsHandle.read(b, {at: offset});
      if(nRead<n){
        // MUST zero-fill short reads (per the docs)
        heap.fill(0, dest + nRead, n - nRead);
      }
      return 0;
    }catch(e){
      error("xRead(",arguments,") failed:",e);
      return capi.SQLITE_IOERR_READ;
    }
  })
  ('xWrite', /*i(ppij)*/function(pFile,pSrc,n,offset){
    /* int (*xWrite)(sqlite3_file*, const void*, int iAmt, sqlite3_int64 iOfst) */
    try {
      const f = __opfsHandles[pFile];
      const b = new Uint8Array(wasm.heap8u().buffer, pSrc, n);
      const nOut = f.opfsHandle.write(b, {at: offset});
      if(nOut<n){
        error("xWrite(",arguments,") short write!");
        return capi.SQLITE_IOERR_WRITE;
      }
      return 0;
    }catch(e){
      error("xWrite(",arguments,") failed:",e);
      return capi.SQLITE_IOERR_WRITE;
    }
  })
  ('xTruncate', /*i(pj)*/async function(pFile,sz){
    /* int (*xTruncate)(sqlite3_file*, sqlite3_int64 size) */
    try{
      warn("xTruncate(",arguments,") uses await");
      const f = __opfsHandles[pFile];
      await f.opfsHandle.truncate(sz);
      return 0;
    }
    catch(e){
      error("xTruncate(",arguments,") failed:",e);
      return capi.SQLITE_IOERR_TRUNCATE;
    }
  })
  ('xSync', /*i(pi)*/async function(pFile,flags){
    /* int (*xSync)(sqlite3_file*, int flags) */
    try {
      warn("xSync(",arguments,") uses await");
      const f = __opfsHandles[pFile];
      await f.opfsHandle.flush();
      return 0;
    }catch(e){
      error("xSync(",arguments,") failed:",e);
      return capi.SQLITE_IOERR_SYNC;
    }
  })
  ('xFileSize', /*i(pp)*/async function(pFile,pSz){
    /* int (*xFileSize)(sqlite3_file*, sqlite3_int64 *pSize) */
    try {
      warn("xFileSize(",arguments,") uses await");
      const f = __opfsHandles[pFile];
      const fsz = await f.opfsHandle.getSize();
      capi.wasm.setMemValue(pSz, fsz,'i64');
      return 0;
    }catch(e){
      error("xFileSize(",arguments,") failed:",e);
      return capi.SQLITE_IOERR_SEEK;
    }
  })
  ('xLock', /*i(pi)*/function(pFile,lockType){
    /* int (*xLock)(sqlite3_file*, int) */
    // Opening a handle locks it automatically.
    warn("xLock(",arguments,") is a no-op");
    return 0;
  })
  ('xUnlock', /*i(pi)*/function(pFile,lockType){
    /* int (*xUnlock)(sqlite3_file*, int) */
    // Opening a handle locks it automatically.
    warn("xUnlock(",arguments,") is a no-op");
    return 0;
  })
  ('xCheckReservedLock', /*i(pp)*/function(pFile,pOut){
    /* int (*xCheckReservedLock)(sqlite3_file*, int *pResOut) */
    // Exclusive lock is automatically acquired when opened
    warn("xCheckReservedLock(",arguments,") is a no-op");
    wasm.setMemValue(pOut,1,'i32');
    return 0;
  })
  ('xFileControl', /*i(pip)*/function(pFile,op,pArg){
    /* int (*xFileControl)(sqlite3_file*, int op, void *pArg) */
    debug("xFileControl(",arguments,") is a no-op");
    return capi.SQLITE_NOTFOUND;
  })
  ('xDeviceCharacteristics',/*i(p)*/function(pFile){
    /* int (*xDeviceCharacteristics)(sqlite3_file*) */
    debug("xDeviceCharacteristics(",pFile,")");
    return capi.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
  });
  // xSectorSize may be NULL
  //('xSectorSize', function(pFile){
  //  /* int (*xSectorSize)(sqlite3_file*) */
  //  log("xSectorSize(",pFile,")");
  //  return 4096 /* ==> SQLITE_DEFAULT_SECTOR_SIZE */;
  //})

  const rc = capi.sqlite3_vfs_register(oVfs.pointer, 0);
  if(rc){
    oVfs.dispose();
    toss("sqlite3_vfs_register(OPFS) failed with rc",rc);
  }
  capi.sqlite3_vfs_register.addReference(oVfs, oIom);
  warn("End of (very incomplete) OPFS setup.", oVfs);
  //oVfs.dispose()/*only because we can't yet do anything with it*/;
});
/* END FILE: api/sqlite3-api-opfs.js */
/* BEGIN FILE: api/sqlite3-api-cleanup.js */
/*
  2022-07-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file is the tail end of the sqlite3-api.js constellation,
  intended to be appended after all other files so that it can clean
  up any global systems temporarily used for setting up the API's
  various subsystems.
*/
'use strict';
self.sqlite3.postInit.forEach(
  self.importScripts/*global is a Worker*/
    ? function(f){
      /** We try/catch/report for the sake of failures which happen in
          a Worker, as those exceptions can otherwise get completely
          swallowed, leading to confusing downstream errors which have
          nothing to do with this failure. */
      try{ f(self, self.sqlite3) }
      catch(e){
        console.error("Error in postInit() function:",e);
        throw e;
      }
    }
  : (f)=>f(self, self.sqlite3)
);
delete self.sqlite3.postInit;
if(self.location && +self.location.port > 1024){
  console.warn("Installing sqlite3 bits as global S for dev-testing purposes.");
  self.S = self.sqlite3;
}
/* Clean up temporary global-scope references to our APIs... */
self.sqlite3.config.Module.sqlite3 = self.sqlite3
/* ^^^^ Currently needed by test code and Worker API setup */;
delete self.sqlite3.capi.util /* arguable, but these are (currently) internal-use APIs */;
delete self.sqlite3 /* clean up our global-scope reference */;
//console.warn("Module.sqlite3 =",Module.sqlite3);
/* END FILE: api/sqlite3-api-cleanup.js */
