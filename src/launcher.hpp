#pragma once

#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace ldfcl {
namespace fs = std::filesystem;

class Error : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

fs::path default_game_directory();
fs::path default_java();
fs::path resolve_game_directory(const fs::path& directory);
enum class GameLayout { automatic, shared, isolated };
std::vector<std::string> installed_versions(const fs::path& game_directory);
int launch(const fs::path& game_directory, const std::string& version,
           const fs::path& java, const fs::path& log = {},
           GameLayout layout = GameLayout::automatic);

int run_process(const fs::path& executable, const std::vector<std::string>& args,
                const fs::path& directory, const fs::path& log);
}  // namespace ldfcl
