cmake_minimum_required(VERSION 3.20)
project(AuraNative CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Static runtime: the module is loaded into the Windows audio service and must not depend on redistributables.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/utf-8 /W3 /EHsc)
add_compile_definitions(UNICODE _UNICODE NOMINMAX)

add_library(AuraAPO SHARED apo.cpp apo.def)
target_link_libraries(AuraAPO PRIVATE ole32)

add_executable(AuraSetup setup.cpp)
target_link_libraries(AuraSetup PRIVATE ole32 advapi32)
target_link_options(AuraSetup PRIVATE "/MANIFESTUAC:level='requireAdministrator' uiAccess='false'")

add_executable(dsp_test dsp_test.cpp)
