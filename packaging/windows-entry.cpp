#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <filesystem>
#include <string>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR arguments, int) {
  wchar_t module[32768];
  const auto length = GetModuleFileNameW(nullptr, module, 32768);
  if (length > 0 && length < 32768) {
    const auto installed = std::filesystem::path(module).parent_path();
#ifdef LDFCL_UNINSTALL_ENTRY
    const auto executable = installed / L"runtime" / L"uninstall" / L"unins000.exe";
#else
    const auto executable = installed / L"runtime" / L"bin" / L"LDFCL.exe";
#endif
    auto command = L"\"" + executable.wstring() + L"\" " + arguments;
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, 0,
                       nullptr, executable.parent_path().c_str(), &startup, &process)) {
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
      return 0;
    }
  }
  MessageBoxW(nullptr, L"无法启动 LDFCL。请检查安装文件。", L"LDFCL", MB_OK | MB_ICONERROR);
  return 1;
}
