# Homebrew formula for watchdog
#
# Goes in a separate tap repo: github.com/shshalom/homebrew-watchdog
# Path inside the tap repo: Formula/watchdog.rb
#
# The release workflow builds binaries on every tag. Update VERSION + the two
# sha256 values below, then copy into the tap repo as Formula/watchdog.rb.
# Intel macOS is not supported in v0.1.0 — Apple Silicon + Linux only.

class Watchdog < Formula
  desc "Real-time spec-compliance and drift enforcement for AI coding agents"
  homepage "https://github.com/shshalom/watchdog"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/shshalom/watchdog/releases/download/v#{version}/watchdog-aarch64-apple-darwin.tar.gz"
      sha256 "REPLACE_WITH_ARM_SHA256"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/shshalom/watchdog/releases/download/v#{version}/watchdog-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "REPLACE_WITH_LINUX_SHA256"
    end
  end

  def install
    bin.install "watchdog"
  end

  def caveats
    <<~EOS
      Next steps:
        cd /path/to/your/project
        watchdog init
        watchdog start

      Optional: set ANTHROPIC_API_KEY to enable the LLM auditor.
      Without it, deterministic rules and the dashboard still work.
    EOS
  end

  test do
    assert_match "watchdog", shell_output("#{bin}/watchdog --help")
  end
end
