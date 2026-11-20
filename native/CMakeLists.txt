cmake_minimum_required(VERSION 3.20)
project(AuraNative C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static runtime: the module is loaded into the Windows audio service and must not depend on redistributables.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/utf-8 /W3 /EHsc)
add_compile_definitions(UNICODE _UNICODE NOMINMAX)

# RNNoise (neural noise suppression), pinned to the v0.1.1 commit — the last release that ships its model in the source tree.
include(FetchContent)
FetchContent_Declare(rnnoise
  GIT_REPOSITORY https://github.com/xiph/rnnoise.git
  GIT_TAG 6cbfd53eb348a8d394e0757b4025c6ded34eb2b6)
FetchContent_MakeAvailable(rnnoise)
add_library(rnnoise STATIC
  ${rnnoise_SOURCE_DIR}/src/denoise.c
  ${rnnoise_SOURCE_DIR}/src/rnn.c
  ${rnnoise_SOURCE_DIR}/src/rnn_data.c
  ${rnnoise_SOURCE_DIR}/src/rnn_reader.c
  ${rnnoise_SOURCE_DIR}/src/pitch.c
  ${rnnoise_SOURCE_DIR}/src/kiss_fft.c
  ${rnnoise_SOURCE_DIR}/src/celt_lpc.c)
target_include_directories(rnnoise PUBLIC ${rnnoise_SOURCE_DIR}/include)
target_compile_definitions(rnnoise PRIVATE _USE_MATH_DEFINES _CRT_SECURE_NO_WARNINGS)
target_compile_options(rnnoise PRIVATE /W0)
file(COPY_FILE ${rnnoise_SOURCE_DIR}/COPYING ${CMAKE_BINARY_DIR}/RNNoise-LICENSE.txt)

add_library(AuraAPO SHARED apo.cpp apo.def)
target_link_libraries(AuraAPO PRIVATE ole32 rnnoise)

add_executable(AuraSetup setup.cpp)
target_link_libraries(AuraSetup PRIVATE ole32 advapi32)
target_link_options(AuraSetup PRIVATE "/MANIFESTUAC:level='requireAdministrator' uiAccess='false'")

add_executable(dsp_test dsp_test.cpp)
target_link_libraries(dsp_test PRIVATE rnnoise)

# The sound of one program (process loopback), for the party section.
add_executable(AuraCapture capture.cpp)
target_link_libraries(AuraCapture PRIVATE ole32 mmdevapi)

# Runs a recording through the same chain as the module (used by the window's «Записи» page).
add_executable(AuraRender render.cpp)
target_link_libraries(AuraRender PRIVATE rnnoise)

# DeepFilterNet 3 (optional): pass -DAURA_DFN_LIB=<df.lib>, libDF built as a static library with the static C runtime.
if(AURA_DFN_LIB)
  foreach(target AuraAPO dsp_test AuraRender)
    target_compile_definitions(${target} PRIVATE AURA_HAVE_DFN)
    target_link_libraries(${target} PRIVATE ${AURA_DFN_LIB} ws2_32 userenv ntdll bcrypt advapi32 dbghelp synchronization)
  endforeach()
endif()
