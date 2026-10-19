#!/bin/bash
# Starts Lavalink and the bot in one container.

cd /opt/Lavalink || exit 1
java -XX:MaxRAMPercentage=50 -jar Lavalink.jar &

cd /app || exit 1

# wait (up to 2 minutes) until Lavalink listens on port 2333
for i in $(seq 1 120); do
  (echo > /dev/tcp/127.0.0.1/2333) 2>/dev/null && break
  sleep 1
done

node index.js &

# if either process stops, stop the container so Railway restarts it
wait -n
exit 1
