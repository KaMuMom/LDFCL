qt_add_executable(ldfcl_gui WIN32 MACOSX_BUNDLE main.cpp controller.cpp controller.hpp)
set_target_properties(ldfcl_gui PROPERTIES OUTPUT_NAME LDFCL)
target_link_libraries(ldfcl_gui PRIVATE ldfcl_core Qt6::Quick Qt6::QuickControls2 Qt6::Concurrent)
if(MSVC)
  target_compile_options(ldfcl_gui PRIVATE /utf-8)
endif()

set(evolve_qml)
foreach(component ETheme ECard EButton EDropdown)
  set(file "evolveui/${component}.qml")
  set_source_files_properties("${file}" PROPERTIES QT_RESOURCE_ALIAS "${component}.qml")
  list(APPEND evolve_qml "${file}")
endforeach()
qt_add_qml_module(ldfcl_gui
  URI Ldfcl
  QML_FILES Main.qml ${evolve_qml}
)

install(TARGETS ldfcl_gui BUNDLE DESTINATION . RUNTIME DESTINATION bin)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/evolveui/LICENSE"
        DESTINATION share/licenses/LDFCL RENAME EvolveUI-LICENSE)
if(WIN32 OR APPLE)
  qt_generate_deploy_qml_app_script(
    TARGET ldfcl_gui OUTPUT_SCRIPT deploy_script NO_UNSUPPORTED_PLATFORM_ERROR)
  install(SCRIPT "${deploy_script}")
endif()
