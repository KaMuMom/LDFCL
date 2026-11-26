#include "launcher.hpp"

#include <iostream>
#include <string_view>

namespace {
void usage() {
  std::cout << "LDFCL - Offline Minecraft launcher\n"
            << "  ldfcl-cli list [--game-dir DIRECTORY]\n"
            << "  ldfcl-cli launch VERSION [--game-dir DIRECTORY] [--java EXECUTABLE]\n";
}

int main_impl(const std::vector<std::string>& args) {
  if (args.empty() || args.front() == "--help" || args.front() == "-h") {
    usage();
    return 0;
  }
  try {
    const auto& command = args.front();
    if (command != "list" && command != "launch") throw ldfcl::Error("Unknown command: " + command);
    size_t index = 1;
    std::string version;
    if (command == "launch") {
      if (index == args.size() || args[index].rfind("--", 0) == 0)
        throw ldfcl::Error("Specify an installed Minecraft version");
      version = args[index++];
    }
    auto root = ldfcl::default_game_directory();
    ldfcl::fs::path java;
    while (index < args.size()) {
      const auto& option = args[index++];
      if (option != "--game-dir" && !(option == "--java" && command == "launch"))
        throw ldfcl::Error("Unknown option: " + option);
      if (index == args.size() || args[index].empty() || args[index].rfind("--", 0) == 0)
        throw ldfcl::Error("Missing value for " + option);
      auto value = ldfcl::fs::u8path(args[index++]);
      if (option == "--game-dir") root = std::move(value);
      else java = std::move(value);
    }
    if (command == "list") {
      for (const auto& installed : ldfcl::installed_versions(root)) std::cout << installed << '\n';
      return 0;
    }
    return ldfcl::launch(root, version, java.empty() ? ldfcl::default_java() : java);
  } catch (const std::exception& error) {
    std::cerr << "LDFCL: " << error.what() << '\n';
    return 1;
  }
}
}  // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> args;
  for (int i = 1; i < argc; ++i) args.push_back(ldfcl::fs::path(argv[i]).u8string());
  return main_impl(args);
}
#else
int main(int argc, char** argv) {
  return main_impl(std::vector<std::string>(argv + 1, argv + argc));
}
#endif
