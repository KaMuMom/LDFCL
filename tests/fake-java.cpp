#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <vector>

namespace fs = std::filesystem;

int verify(const std::vector<std::string>& args) {
  const auto root = fs::current_path();
  std::map<std::string, std::string> flags;
  std::string classpath;
  fs::path natives;
  bool main_class = false;
  bool platform_argument = false;
  for (size_t i = 1; i < args.size(); ++i) {
    const auto& argument = args[i];
    if (argument == "-cp" && i + 1 < args.size()) classpath = args[++i];
    if (argument.rfind("-Djava.library.path=", 0) == 0)
      natives = fs::u8path(argument.substr(20));
    if (argument == "fixture.Main") main_class = true;
    if (argument == "-Dfixture.platform=accepted") platform_argument = true;
    if (argument.rfind("--", 0) == 0 && i + 1 < args.size()) flags[argument] = args[++i];
  }
#ifdef _WIN32
  constexpr auto separator = ";";
#else
  constexpr auto separator = ":";
#endif
  const auto& version = flags["--version"];
  const auto jar = root / "versions" / version / (version + ".jar");
  const auto library = root / "libraries" / "com" / "fixture" / "base" / "1.0" / "base-1.0.jar";
  const bool legacy = version == "legacy";
  if (!main_class || (!legacy && !platform_argument) ||
      classpath != library.u8string() + separator + jar.u8string() ||
      flags["--username"] != "Player" ||
      flags["--gameDir"] != root.u8string() ||
      flags["--accessToken"] != "0" ||
      (!legacy && (flags["--assetIndex"] != "fixture" || flags["--literal"] != "with space \"quote\" \\")) ||
      flags.count("--demo") || flags.count("--foreign")) {
    std::cerr << "Wrong Java arguments or working directory\n";
    for (const auto& arg : args) std::cerr << '[' << arg << "]\n";
    return 41;
  }
  if (!fs::is_regular_file(natives / "native.bin") || fs::exists(natives / "META-INF")) {
    std::cerr << "Native library missing or exclusion ignored (" << natives.u8string() << ")\n";
    return 42;
  }
  std::ofstream(root / "native-location.txt") << natives.u8string();
  std::cout << "Started " << version << " successfully\n";
  return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> args;
  for (int i = 0; i < argc; ++i) args.push_back(fs::path(argv[i]).u8string());
  return verify(args);
}
#else
int main(int argc, char** argv) {
  return verify(std::vector<std::string>(argv, argv + argc));
}
#endif
