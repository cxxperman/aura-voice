cmake_minimum_required(VERSION 3.20)
project(DfnExperiment CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
add_compile_options(/utf-8 /EHsc)
add_compile_definitions(NOMINMAX)
add_executable(dfn_test dfn_test.cpp)
# DF_LIB: libDF built as a static library with the static C runtime.
target_link_libraries(dfn_test PRIVATE ${DF_LIB} ws2_32 userenv ntdll bcrypt advapi32 dbghelp synchronization)
