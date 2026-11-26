#include "launcher.hpp"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace ldfcl {
#ifdef _WIN32
namespace {
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
};

std::wstring quote(const std::wstring& arg) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (const auto c : arg) {
    if (c == L'\\') {
      ++backslashes;
      continue;
    }
    result.append(c == L'"' ? backslashes * 2 + 1 : backslashes, L'\\');
    result += c;
    backslashes = 0;
  }
  result.append(backslashes * 2, L'\\');
  return result + L'"';
}
}  // namespace

int run_process(const fs::path& executable, const std::vector<std::string>& args,
                const fs::path& directory, const fs::path& log) {
  auto command = quote(executable.wstring());
  for (const auto& arg : args) command += L" " + quote(fs::u8path(arg).wstring());

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  Handle log_handle, null_input;
  if (!log.empty()) {
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    log_handle.value = CreateFileW(log.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
        &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    null_input.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (!log_handle.valid() || !null_input.valid())
      throw Error("Cannot open game output log: " + log.u8string());
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = startup.hStdError = log_handle.value;
    startup.hStdInput = null_input.value;
  }

  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr,
          !log.empty(), log.empty() ? 0 : CREATE_NO_WINDOW, nullptr,
          directory.c_str(), &startup, &process)) {
    throw Error("Cannot start Java (Windows error " + std::to_string(GetLastError()) + ")");
  }
  Handle java_process{process.hProcess}, java_thread{process.hThread};
  DWORD exit_code;
  if (WaitForSingleObject(java_process.value, INFINITE) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(java_process.value, &exit_code)) {
    throw Error("Cannot read Java process result");
  }
  return static_cast<int>(exit_code);
}
#else
int run_process(const fs::path& executable, const std::vector<std::string>& args,
                const fs::path& directory, const fs::path& log) {
  std::vector<char*> argv;
  argv.reserve(args.size() + 2);
  argv.push_back(const_cast<char*>(executable.c_str()));
  for (const auto& arg : args) argv.push_back(const_cast<char*>(arg.c_str()));
  argv.push_back(nullptr);

  const pid_t child = fork();
  if (child < 0) throw Error("Cannot start Java: " + std::string(std::strerror(errno)));
  if (child == 0) {
    if (chdir(directory.c_str()) != 0) _exit(126);
    if (!log.empty()) {
      const int fd = open(log.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (fd < 0 || dup2(fd, STDOUT_FILENO) < 0 || dup2(fd, STDERR_FILENO) < 0) _exit(126);
      if (fd > STDERR_FILENO) close(fd);
    }
    execv(executable.c_str(), argv.data());
    _exit(126);
  }

  int status{};
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) throw Error("Cannot wait for Java: " + std::string(std::strerror(errno)));
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
#endif
}  // namespace ldfcl
