file(REMOVE_RECURSE "${WORK}")
set(parent "${WORK}")
set(WORK "${WORK}/.minecraft")
set(common "${WORK}/libraries/com/fixture/base/1.0")
file(MAKE_DIRECTORY "${common}" "${WORK}/versions/modern" "${WORK}/versions/legacy")
file(WRITE "${common}/base-1.0.jar" "test library")
file(WRITE "${WORK}/versions/modern/modern.jar" "test client")
file(WRITE "${WORK}/versions/legacy/legacy.jar" "test client")
file(WRITE "${WORK}/assets/indexes/fixture.json" "{}")
file(WRITE "${WORK}/native-fixture/native.bin" "native fixture")
file(WRITE "${WORK}/native-fixture/META-INF/ignored.txt" "not a native library")
execute_process(
  COMMAND "${CMAKE_COMMAND}" -E tar cf "${common}/base-1.0-natives.jar"
          --format=zip native.bin META-INF
  WORKING_DIRECTORY "${WORK}/native-fixture"
  COMMAND_ERROR_IS_FATAL ANY
)
if(CMAKE_HOST_WIN32)
  set(os windows)
elseif(CMAKE_HOST_APPLE)
  set(os osx)
else()
  set(os linux)
endif()
set(libraries [=[
  {"name":"com.fixture:base:1.0",
   "natives":{"windows":"natives","linux":"natives","osx":"natives"},
   "downloads":{"artifact":{"path":"com/fixture/base/1.0/base-1.0.jar"},
                "classifiers":{"natives":{"path":"com/fixture/base/1.0/base-1.0-natives.jar"}}}},
  {"name":"invalid:not-installed:1",
   "rules":[{"action":"allow","os":{"name":"unrelated-platform"}}]}
]=])
set(modern [=[
{
  "mainClass":"fixture.Main",
  "assetIndex":{"id":"fixture"},
  "libraries":[@libraries@],
  "arguments":{
    "jvm":["-Djava.library.path=${natives_directory}","-cp","${classpath}",
           {"rules":[{"action":"allow","os":{"name":"@os@"}}],"value":"-Dfixture.platform=accepted"}],
    "game":["--username","${auth_player_name}","--gameDir","${game_directory}",
            "--accessToken","${auth_access_token}","--version","${version_name}",
            "--assetIndex","${assets_index_name}","--literal","with space \"quote\" \\",
            {"rules":[{"action":"allow","features":{"is_demo_user":true}}],"value":"--demo"},
            {"rules":[{"action":"allow","os":{"name":"unrelated-platform"}}],"value":"--foreign"}]
  }
}
]=])
string(CONFIGURE "${modern}" modern @ONLY)
file(WRITE "${WORK}/versions/modern/modern.json" "${modern}")
set(legacy [=[
{
  "mainClass":"fixture.Main",
  "libraries":[@libraries@],
  "minecraftArguments":"--username ${auth_player_name} --gameDir ${game_directory} --accessToken ${auth_access_token} --version ${version_name}"
}
]=])
string(CONFIGURE "${legacy}" legacy @ONLY)
file(WRITE "${WORK}/versions/legacy/legacy.json" "${legacy}")
file(WRITE "${WORK}/libraries/com/fixture/loader/1.0/loader-1.0.jar" "test loader")
file(WRITE "${WORK}/versions/pcl-fabric/pcl-fabric.json"
  [[{"inheritsFrom":"modern","libraries":[{"name":"com.fixture:loader:1.0"}],"arguments":{"game":["--loader","fabric"]}}]])
file(WRITE "${WORK}/versions/pcl-fabric/PCL/Setup.ini" "VersionArgumentIndieV2:True\r\n")
file(WRITE "${WORK}/versions/pcl-shared/pcl-shared.json" [[{"inheritsFrom":"modern"}]])
file(WRITE "${WORK}/versions/pcl-shared/PCL/Setup.ini" "VersionArgumentIndieV2:False\r\n")
file(MAKE_DIRECTORY "${WORK}/versions/pcl-shared/saves")
file(WRITE "${WORK}/versions/hmcl-local/hmcl-local.json" [[{"inheritsFrom":"modern"}]])
file(WRITE "${WORK}/versions/hmcl-local/.hmcl/config/instance-game-settings.json"
  [[{"overrideProperties":["runningDirectory"],"runningDirectory":""}]])
file(WRITE "${WORK}/versions/loop/loop.json" [[{"inheritsFrom":"loop"}]])

execute_process(COMMAND "${LAUNCHER}" list --game-dir "${parent}"
  OUTPUT_VARIABLE versions COMMAND_ERROR_IS_FATAL ANY
)
if(NOT versions STREQUAL "pcl-shared\npcl-fabric\nmodern\nlegacy\nhmcl-local\n")
  message(FATAL_ERROR "Incorrect version list: ${versions}")
endif()

foreach(version modern legacy pcl-fabric hmcl-local pcl-shared)
  execute_process(COMMAND "${LAUNCHER}" launch "${version}" --game-dir "${parent}" --java "${JAVA}"
    OUTPUT_VARIABLE output COMMAND_ERROR_IS_FATAL ANY
  )
  if(NOT output MATCHES "Started ${version} successfully")
    message(FATAL_ERROR "Java fixture did not start: ${output}")
  endif()
  if(version STREQUAL "pcl-fabric" OR version STREQUAL "hmcl-local")
    file(READ "${WORK}/versions/${version}/native-location.txt" native_dir)
  else()
    file(READ "${WORK}/native-location.txt" native_dir)
  endif()
  if(EXISTS "${native_dir}")
    message(FATAL_ERROR "Temporary natives were not removed")
  endif()
endforeach()

file(REMOVE "${common}/base-1.0.jar")
execute_process(COMMAND "${LAUNCHER}" launch modern --game-dir "${WORK}" --java "${JAVA}"
  RESULT_VARIABLE result ERROR_VARIABLE error
)
if(NOT result EQUAL 1 OR NOT error MATCHES "Missing local game file.*base-1.0.jar")
  message(FATAL_ERROR "Incomplete game installation did not report the missing library: ${result}, ${error}")
endif()
