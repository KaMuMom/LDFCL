#include "launcher.hpp"

#include <miniz.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <map>
#include <memory>
#include <regex>
#include <set>
#include <sstream>
#include <string_view>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/utsname.h>
#include <unistd.h>
#endif

namespace ldfcl {
namespace {
using Json = nlohmann::json;

#ifdef _WIN32
constexpr auto os_name = "windows";
constexpr char classpath_separator = ';';
fs::path environment_path(const wchar_t* name) {
  const auto* value = _wgetenv(name);
  return value ? fs::path(value) : fs::path();
}
std::string os_version() {
  using GetVersion = LONG (WINAPI*)(OSVERSIONINFOW*);
  auto* module = GetModuleHandleW(L"ntdll.dll");
  const auto function = module
      ? reinterpret_cast<GetVersion>(reinterpret_cast<void*>(GetProcAddress(module, "RtlGetVersion")))
      : nullptr;
  OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  if (!function || function(&info) != 0) return {};
  return std::to_string(info.dwMajorVersion) + "." +
      std::to_string(info.dwMinorVersion) + "." + std::to_string(info.dwBuildNumber);
}
#else
#ifdef __APPLE__
constexpr auto os_name = "osx";
#else
constexpr auto os_name = "linux";
#endif
constexpr char classpath_separator = ':';
fs::path environment_path(const char* name) {
  const auto* value = std::getenv(name);
  return value ? fs::path(value) : fs::path();
}
std::string os_version() {
  struct utsname name {};
  return uname(&name) == 0 ? std::string(name.release) : std::string();
}
#endif

#if defined(__aarch64__) || defined(_M_ARM64)
constexpr auto os_arch = "aarch64";
#elif defined(__x86_64__) || defined(_M_X64)
constexpr auto os_arch = "amd64";
#elif defined(__i386__) || defined(_M_IX86)
constexpr auto os_arch = "x86";
#else
constexpr auto os_arch = "unknown";
#endif
constexpr auto architecture_bits = sizeof(void*) == 8 ? "64" : "32";

std::vector<std::string> split(std::string_view value, char delimiter) {
  std::vector<std::string> parts;
  for (size_t start = 0;;) {
    const auto end = value.find(delimiter, start);
    parts.emplace_back(value.substr(start, end - start));
    if (end == std::string_view::npos) return parts;
    start = end + 1;
  }
}

bool valid_segment(std::string_view value) {
  if (value.empty() || value == "." || value == ".." ||
      value.back() == '.' || value.back() == ' ') return false;
  return value.find_first_of("/\\:\"*?<>|") == std::string_view::npos &&
      std::none_of(value.begin(), value.end(), [](unsigned char c) { return c < 32; });
}

fs::path relative_path(const std::string& value) {
  fs::path result;
  for (const auto& component : split(value, '/')) {
    if (!valid_segment(component)) throw Error("Invalid relative path: " + value);
    result /= fs::u8path(component);
  }
  return result;
}

void require_file(const fs::path& file) {
  if (!fs::is_regular_file(file)) {
    throw Error("Missing local game file: " + file.u8string());
  }
}

Json read_json(const fs::path& file) {
  require_file(file);
  std::ifstream input(file, std::ios::binary);
  if (!input) throw Error("Cannot read " + file.u8string());
  try {
    return Json::parse(input);
  } catch (const Json::exception& error) {
    throw Error("Invalid version JSON (" + file.u8string() + "): " + error.what());
  }
}

std::string library_key(const Json& library) {
  const auto name = library.at("name").get<std::string>();
  const auto extension = name.find('@');
  const auto parts = split(std::string_view(name).substr(0, extension), ':');
  if (parts.size() < 3) throw Error("Invalid library: " + name);
  return parts[0] + ':' + parts[1] + ':' + (parts.size() > 3 ? parts[3] : "") +
      (extension == std::string::npos ? "@jar" : name.substr(extension));
}

struct LocalVersion {
  Json metadata;
  fs::path jar;
};

LocalVersion load_version(const fs::path& root, const std::string& id,
                          std::vector<std::string> chain = {}) {
  if (!valid_segment(id) || chain.size() >= 32 ||
      std::find(chain.begin(), chain.end(), id) != chain.end())
    throw Error("Invalid or cyclic version inheritance: " + id);
  chain.push_back(id);
  const auto folder = root / "versions" / fs::u8path(id);
  auto child = read_json(folder / fs::u8path(id + ".json"));
  auto jar = folder / fs::u8path(id + ".jar");
  if (child.contains("jar")) {
    const auto jar_id = child.at("jar").get<std::string>();
    if (!valid_segment(jar_id)) throw Error("Invalid client JAR: " + jar_id);
    jar = root / "versions" / fs::u8path(jar_id) / fs::u8path(jar_id + ".jar");
  }
  if (!child.contains("inheritsFrom")) return {std::move(child), std::move(jar)};

  auto parent = load_version(root, child.at("inheritsFrom").get<std::string>(), std::move(chain));
  if (!child.contains("jar") && !fs::is_regular_file(jar)) jar = parent.jar;

  auto libraries = Json::array();
  std::set<std::string> child_libraries;
  for (const auto& library : child.value("libraries", Json::array())) {
    child_libraries.insert(library_key(library));
    libraries.push_back(library);
  }
  for (const auto& library : parent.metadata.value("libraries", Json::array())) {
    if (!child_libraries.count(library_key(library))) libraries.push_back(library);
  }

  auto arguments = parent.metadata.value("arguments", Json::object());
  for (const auto& part : {"jvm", "game"}) {
    for (const auto& token : child.value("arguments", Json::object()).value(part, Json::array())) {
      arguments[part].push_back(token);
    }
  }
  parent.metadata.update(child);
  parent.metadata["libraries"] = std::move(libraries);
  if (child.contains("minecraftArguments") && !child.contains("arguments")) arguments.erase("game");
  if (!arguments.empty()) parent.metadata["arguments"] = std::move(arguments);
  else parent.metadata.erase("arguments");
  return {std::move(parent.metadata), std::move(jar)};
}

GameLayout pcl_layout(const fs::path& folder) {
  std::ifstream config(folder / "PCL" / "Setup.ini");
  GameLayout legacy = GameLayout::automatic;
  for (std::string line; std::getline(config, line);) {
    if (line.rfind("\xef\xbb\xbf", 0) == 0) line.erase(0, 3);
    const auto separator = line.find_first_of(":=");
    if (separator == std::string::npos) continue;
    const auto key = line.substr(0, separator);
    auto value = line.substr(separator + 1);
    const auto first = value.find_first_not_of(" \t\r");
    if (first == std::string::npos) continue;
    value = value.substr(first, value.find_last_not_of(" \t\r") - first + 1);
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (key == "VersionArgumentIndieV2") {
      if (value == "true" || value == "1") return GameLayout::isolated;
      if (value == "false" || value == "0") return GameLayout::shared;
    }
    if (key == "VersionArgumentIndie") {
      if (value == "1") legacy = GameLayout::isolated;
      if (value == "2") legacy = GameLayout::shared;
    }
  }
  return legacy;
}

bool uses_instance_directory(const fs::path& folder, GameLayout layout) {
  if (layout == GameLayout::automatic) layout = pcl_layout(folder);
  if (layout != GameLayout::automatic) return layout == GameLayout::isolated;
  const auto hmcl_config = folder / ".hmcl" / "config" / "instance-game-settings.json";
  if (fs::is_regular_file(hmcl_config)) {
    try {
      const auto settings = read_json(hmcl_config);
      const auto overrides = settings.value("overrideProperties", Json::array());
      if (std::find(overrides.begin(), overrides.end(), "runningDirectory") != overrides.end() &&
          settings.value("runningDirectory", std::string()).empty()) return true;
    } catch (const std::exception&) {
      // Older or unreadable settings still allow layout detection from local files.
    }
  }
  const auto hmcl_legacy = folder / "hmclversion.cfg";
  if (fs::is_regular_file(hmcl_legacy)) {
    try {
      const auto settings = read_json(hmcl_legacy);
      if (!settings.value("usesGlobal", false)) {
        const auto mode = settings.value("gameDirType", Json());
        if (mode == 1 || mode == "VERSION_FOLDER") return true;
        if (mode == 0 || mode == "ROOT_FOLDER") return false;
      }
    } catch (const std::exception&) {
      // Try the instance's actual files if older settings cannot be read.
    }
  }
  return fs::is_directory(folder / "saves") || fs::is_directory(folder / "mods") ||
      fs::is_directory(folder / "resourcepacks") || fs::is_directory(folder / "shaderpacks") ||
      fs::is_regular_file(folder / "options.txt");
}

bool matches_rule(const Json& rule) {
  if (const auto os = rule.find("os"); os != rule.end()) {
    if (os->contains("name") && os->at("name") != os_name) return false;
    if (os->contains("arch")) {
      const auto arch = os->at("arch").get<std::string>();
      if (!(arch == os_arch || (arch == "x86_64" && std::string_view(os_arch) == "amd64") ||
            (arch == "arm64" && std::string_view(os_arch) == "aarch64"))) return false;
    }
    if (os->contains("version") && !std::regex_search(
          os_version(), std::regex(os->at("version").get<std::string>()))) return false;
  }
  if (const auto features = rule.find("features"); features != rule.end()) {
    // The basic launcher supplies no optional account, quick-play or resolution features.
    for (const auto& feature : *features) {
      if (feature.get<bool>()) return false;
    }
  }
  return true;
}

bool permitted(const Json& entry) {
  const auto rules = entry.find("rules");
  if (rules == entry.end()) return true;
  bool allowed = false;
  for (const auto& rule : *rules) {
    if (matches_rule(rule)) allowed = rule.at("action") == "allow";
  }
  return allowed;
}

void append_arguments(std::vector<std::string>& args, const Json& entries) {
  for (const auto& entry : entries) {
    if (entry.is_string()) {
      args.push_back(entry.get<std::string>());
    } else if (permitted(entry)) {
      const auto& value = entry.at("value");
      if (value.is_array()) {
        for (const auto& token : value) args.push_back(token.get<std::string>());
      } else {
        args.push_back(value.get<std::string>());
      }
    }
  }
}

std::string maven_path(const std::string& name, const std::string& native = {}) {
  const auto suffix = name.find('@');
  const auto extension = suffix == std::string::npos ? "jar" : name.substr(suffix + 1);
  const auto segments = split(std::string_view(name).substr(0, suffix), ':');
  if (segments.size() < 3 || segments.size() > 4) throw Error("Invalid library: " + name);
  auto group = segments[0];
  std::replace(group.begin(), group.end(), '.', '/');
  const auto classifier = !native.empty() ? native : segments.size() == 4 ? segments[3] : "";
  return group + '/' + segments[1] + '/' + segments[2] + '/' +
      segments[1] + '-' + segments[2] + (classifier.empty() ? "" : '-' + classifier) + '.' + extension;
}

struct TemporaryNatives {
  fs::path path;
  TemporaryNatives() {
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    for (int attempt = 0; attempt < 100; ++attempt) {
      path = fs::temp_directory_path() /
          ("ldfcl-native-" + std::to_string(stamp) + "-" + std::to_string(attempt));
      if (fs::create_directory(path)) return;
    }
    throw Error("Cannot create a temporary directory for native libraries");
  }
  ~TemporaryNatives() {
    std::error_code ignored;
    fs::remove_all(path, ignored);
  }
  TemporaryNatives(const TemporaryNatives&) = delete;
  TemporaryNatives& operator=(const TemporaryNatives&) = delete;
};

struct ZipReader {
  mz_zip_archive zip{};
  ~ZipReader() { if (zip.m_pState) mz_zip_reader_end(&zip); }
};

void extract_natives(const fs::path& archive, const fs::path& target,
                     const std::vector<std::string>& exclusions) {
  require_file(archive);
  std::ifstream input(archive, std::ios::binary);
  if (!input) throw Error("Cannot read native archive: " + archive.u8string());
  // Use C++ streams for Unicode archive paths on Windows.
  const std::string bytes((std::istreambuf_iterator<char>(input)), {});
  ZipReader reader;
  auto& zip = reader.zip;
  if (!mz_zip_reader_init_mem(&zip, bytes.data(), bytes.size(), 0))
    throw Error("Invalid native archive: " + archive.u8string());
  for (mz_uint index = 0; index < mz_zip_reader_get_num_files(&zip); ++index) {
    if (mz_zip_reader_is_file_a_directory(&zip, index)) continue;
    const auto length = mz_zip_reader_get_filename(&zip, index, nullptr, 0);
    if (length < 2) throw Error("Invalid filename in native archive");
    std::string name(length, '\0');
    mz_zip_reader_get_filename(&zip, index, name.data(), length);
    name.pop_back();
    if (name.rfind("META-INF/", 0) == 0 || std::any_of(
          exclusions.begin(), exclusions.end(),
          [&](const auto& prefix) { return name.rfind(prefix, 0) == 0; })) continue;
    const auto file = target / relative_path(name);
    fs::create_directories(file.parent_path());
    size_t size = 0;
    std::unique_ptr<void, decltype(&mz_free)> data(
        mz_zip_reader_extract_to_heap(&zip, index, &size, 0), mz_free);
    if (!data) throw Error("Cannot extract native library: " + name);
    std::ofstream output(file, std::ios::binary);
    output.write(static_cast<const char*>(data.get()), static_cast<std::streamsize>(size));
    if (!output) throw Error("Cannot write native library: " + file.u8string());
  }
}

std::string prepare_classpath(const Json& version, const fs::path& root,
                              const fs::path& jar, const fs::path& natives) {
  std::string result;
  const auto root_libraries = root / "libraries";
  auto add = [&](const fs::path& file) {
    require_file(file);
    if (!result.empty()) result += classpath_separator;
    result += file.u8string();
  };
  for (const auto& library : version.at("libraries")) {
    if (!permitted(library)) continue;
    const auto downloads = library.find("downloads");
    if (downloads == library.end()) {
      add(root_libraries / relative_path(maven_path(library.at("name").get<std::string>())));
    } else if (const auto artifact = downloads->find("artifact"); artifact != downloads->end()) {
      add(root_libraries / relative_path(artifact->at("path").get<std::string>()));
    }
    const auto native = library.find("natives");
    if (native == library.end() || !native->contains(os_name)) continue;
    auto classifier = native->at(os_name).get<std::string>();
    if (const auto arch = classifier.find("${arch}"); arch != std::string::npos)
      classifier.replace(arch, 7, architecture_bits);
    const auto path = downloads == library.end()
        ? maven_path(library.at("name").get<std::string>(), classifier)
        : downloads->at("classifiers").at(classifier).at("path").get<std::string>();
    const auto exclusions = library.value("extract", Json::object())
        .value("exclude", std::vector<std::string>());
    extract_natives(root_libraries / relative_path(path), natives, exclusions);
  }
  add(jar);
  return result;
}

std::string expand(std::string_view input, const std::map<std::string, std::string>& values) {
  std::string result;
  size_t start = 0;
  while (true) {
    const auto marker = input.find("${", start);
    result += input.substr(start, marker - start);
    if (marker == std::string_view::npos) return result;
    const auto end = input.find('}', marker + 2);
    if (end == std::string_view::npos) throw Error("Unclosed argument variable");
    const auto key = std::string(input.substr(marker + 2, end - marker - 2));
    const auto value = values.find(key);
    if (value == values.end()) throw Error("Unsupported version argument: ${" + key + "}");
    result += value->second;
    start = end + 1;
  }
}
}  // namespace

fs::path default_game_directory() {
#ifdef _WIN32
  const auto home = environment_path(L"APPDATA");
#elif defined(__APPLE__)
  const auto home = environment_path("HOME");
  return home.empty() ? fs::current_path() / ".minecraft"
                      : home / "Library" / "Application Support" / "minecraft";
#else
  const auto home = environment_path("HOME");
#endif
  return (home.empty() ? fs::current_path() : home) / ".minecraft";
}

fs::path default_java() {
#ifdef _WIN32
  const auto java_home = environment_path(L"JAVA_HOME");
  const auto find_java = [](const fs::path& directory) -> fs::path {
    for (const auto* filename : {L"javaw.exe", L"java.exe"}) {
      const auto executable = directory / filename;
      if (fs::is_regular_file(executable)) return fs::absolute(executable);
    }
    return {};
  };
  if (!java_home.empty()) {
    if (auto executable = find_java(java_home / "bin"); !executable.empty()) return executable;
  }
  for (auto directory : split(environment_path(L"PATH").u8string(), ';')) {
    if (directory.size() >= 2 && directory.front() == '"' && directory.back() == '"')
      directory = directory.substr(1, directory.size() - 2);
    if (!directory.empty()) {
      if (auto executable = find_java(fs::u8path(directory)); !executable.empty()) return executable;
    }
  }
#else
  const auto java_home = environment_path("JAVA_HOME");
  const auto candidate = java_home / "bin" / "java";
  if (!java_home.empty() && fs::is_regular_file(candidate) && access(candidate.c_str(), X_OK) == 0)
    return candidate;
  for (const auto& part : split(environment_path("PATH").u8string(), ':')) {
    const auto file = fs::absolute((part.empty() ? fs::current_path() : fs::u8path(part)) / "java");
    if (fs::is_regular_file(file) && access(file.c_str(), X_OK) == 0) return file;
  }
#endif
  return {};
}

fs::path resolve_game_directory(const fs::path& directory) {
  const auto root = fs::absolute(directory).lexically_normal().make_preferred();
  if (!fs::is_directory(root / "versions") && fs::is_directory(root / ".minecraft" / "versions"))
    return root / ".minecraft";
  return root;
}

std::vector<std::string> installed_versions(const fs::path& game_directory) {
  std::vector<std::string> result;
  const auto root = resolve_game_directory(game_directory);
  const auto versions = root / "versions";
  if (!fs::is_directory(versions)) return result;
  for (const auto& entry : fs::directory_iterator(versions)) {
    const auto id = entry.path().filename().u8string();
    const auto metadata = entry.path() / fs::u8path(id + ".json");
    if (!entry.is_directory() || !valid_segment(id) || !fs::is_regular_file(metadata)) continue;
    try {
      const auto version = load_version(root, id);
      if (version.metadata.contains("mainClass") && fs::is_regular_file(version.jar)) result.push_back(id);
    } catch (const std::exception&) {
      // A broken metadata file should not hide other installed versions.
    }
  }
  std::sort(result.begin(), result.end(), std::greater<>());
  return result;
}

int launch(const fs::path& game_directory, const std::string& id, const fs::path& java,
           const fs::path& log, GameLayout layout) {
  if (!valid_segment(id)) throw Error("Invalid version ID");
  if (java.empty()) throw Error("Choose an installed Java executable");
  const auto executable = fs::absolute(java).make_preferred();
  if (!fs::is_regular_file(executable))
    throw Error("Java executable not found: " + executable.u8string());
  const auto root = resolve_game_directory(game_directory);
  const auto directory = root / "versions" / fs::u8path(id);
  const auto instance = uses_instance_directory(directory, layout) ? directory : root;
  const auto [version, jar] = load_version(root, id);
  const auto assets = root / "assets";
  const auto index_id = version.value("assetIndex", Json::object()).value(
      "id", version.value("assets", std::string("legacy")));
  if (!valid_segment(index_id)) throw Error("Invalid asset index ID");
  if (version.contains("assetIndex")) require_file(assets / "indexes" / fs::u8path(index_id + ".json"));

  TemporaryNatives natives;
  const auto classpath = prepare_classpath(version, root, jar, natives.path);
  const auto virtual_assets = assets / "virtual" / fs::u8path(index_id);
  std::map<std::string, std::string> values{
    {"auth_player_name", "Player"},
    {"auth_uuid", "a01e3843e5213998958af459800e4d11"},
    {"auth_access_token", "0"}, {"auth_session", "0"},
    {"auth_xuid", "0"}, {"clientid", "0"}, {"user_type", "legacy"},
    {"user_properties", "{}"}, {"profile_properties", "{}"},
    {"version_name", id}, {"version_type", version.value("type", std::string("release"))},
    {"game_directory", instance.u8string()}, {"assets_root", assets.u8string()},
    {"game_assets", (fs::is_directory(virtual_assets) ? virtual_assets : assets).u8string()},
    {"assets_index_name", index_id}, {"natives_directory", natives.path.u8string()},
    {"library_directory", (root / "libraries").u8string()}, {"classpath", classpath},
    {"classpath_separator", std::string(1, classpath_separator)},
    {"launcher_name", "LDFCL"}, {"launcher_version", LDFCL_VERSION},
  };

  std::vector<std::string> args{"-Xmx2G"};
#ifdef __APPLE__
  // Mojang's legacy metadata does not always include this JVM flag on macOS.
  args.push_back("-XstartOnFirstThread");
#endif
  const auto arguments = version.find("arguments");
  if (arguments != version.end() && arguments->contains("jvm")) {
    append_arguments(args, arguments->at("jvm"));
  } else {
    args.insert(args.end(), {"-Djava.library.path=${natives_directory}", "-cp", "${classpath}"});
  }
  if (const auto logging = version.find("logging");
      logging != version.end() && logging->contains("client")) {
    const auto& client = logging->at("client");
    const auto name = client.at("file").at("id").get<std::string>();
    if (!valid_segment(name)) throw Error("Invalid logging configuration name");
    const auto config = assets / "log_configs" / fs::u8path(name);
    if (fs::is_regular_file(config)) {
      values["path"] = config.u8string();
      args.push_back(client.at("argument").get<std::string>());
    }
  }
  args.push_back(version.at("mainClass").get<std::string>());
  if (arguments != version.end() && arguments->contains("game")) {
    append_arguments(args, arguments->at("game"));
  } else if (version.contains("minecraftArguments")) {
    std::istringstream tokens(version.at("minecraftArguments").get<std::string>());
    for (std::string token; tokens >> token;) args.push_back(std::move(token));
  }
  for (auto& arg : args) arg = expand(arg, values);
  return run_process(executable, args, instance, log);
}
}  // namespace ldfcl
