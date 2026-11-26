cmake_minimum_required(VERSION 3.24)
project(LDFCL VERSION 1.0.0 LANGUAGES C CXX)

include(FetchContent)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
  TLS_VERIFY TRUE
)
FetchContent_Declare(miniz
  URL https://github.com/richgel999/miniz/releases/download/3.0.2/miniz-3.0.2.zip
  URL_HASH SHA256=ada38db0b703a56d3dd6d57bf84a9c5d664921d870d8fea4db153979fb5332c5
  TLS_VERIFY TRUE
)
FetchContent_MakeAvailable(nlohmann_json miniz)
add_library(ldfcl_zip STATIC "${miniz_SOURCE_DIR}/miniz.c")
target_include_directories(ldfcl_zip PUBLIC "${miniz_SOURCE_DIR}")

add_library(ldfcl_core STATIC src/launcher.cpp src/process.cpp)
target_compile_features(ldfcl_core PUBLIC cxx_std_17)
target_include_directories(ldfcl_core PUBLIC src)
target_link_libraries(ldfcl_core PRIVATE nlohmann_json::nlohmann_json ldfcl_zip)
if(MSVC)
  target_compile_options(ldfcl_core PRIVATE /W4 /utf-8)
else()
  target_compile_options(ldfcl_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(ldfcl src/cli.cpp)
target_link_libraries(ldfcl PRIVATE ldfcl_core)
set_target_properties(ldfcl PROPERTIES OUTPUT_NAME ldfcl-cli)
if(MINGW)
  target_link_options(ldfcl PRIVATE -municode -static)
endif()

option(LDFCL_BUILD_GUI "Build the Qt Quick desktop launcher" ON)
if(LDFCL_BUILD_GUI)
  find_package(Qt6 6.8 REQUIRED COMPONENTS Quick QuickControls2 Concurrent)
  qt_standard_project_setup(REQUIRES 6.8)
  add_subdirectory(ui)
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(ldfcl_fake_java tests/fake-java.cpp)
  target_compile_features(ldfcl_fake_java PRIVATE cxx_std_17)
  if(MINGW)
    target_link_options(ldfcl_fake_java PRIVATE -municode -static)
  endif()
  add_test(NAME launch_offline
    COMMAND "${CMAKE_COMMAND}"
      "-DLAUNCHER=$<TARGET_FILE:ldfcl>" "-DJAVA=$<TARGET_FILE:ldfcl_fake_java>"
      "-DWORK=${CMAKE_CURRENT_BINARY_DIR}/fixture game"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/launch.cmake")
endif()
