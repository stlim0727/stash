#!/bin/bash
# Refresh ADB/platform-tools (Maestro needs a current adb) and install Maestro
# on the HyperExecute runner. Verbatim from the LambdaTest Maestro sample.
sudo rm -f /usr/bin/adb
sudo rm -rf /usr/lib/android-sdk/platform-tools

sudo mkdir -p /usr/local/android-sdk
cd /usr/local/android-sdk/
sudo curl -OL https://dl.google.com/android/repository/platform-tools-latest-linux.zip
sudo unzip platform-tools-latest-linux.zip
sudo rm -f platform-tools-latest-linux.zip
sudo ln -s /usr/local/android-sdk/platform-tools/adb /usr/bin/adb
sudo cp -r /usr/local/android-sdk/platform-tools /usr/lib/android-sdk/

# Install Maestro
mkdir -p ~/maestro-dir
cd ~/maestro-dir
curl -Ls "https://get.maestro.mobile.dev" | bash
sleep 5
export PATH="$PATH":"$HOME/.maestro/bin"
