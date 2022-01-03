const server = require("http").createServer();

const io = require("socket.io").listen(server, { transports: ["websocket"] });

var spawn = require("child_process").spawn;

spawn("ffmpeg", ["-h"]).on("error", function (m) {
  console.error(
    "FFMpeg not found in system cli; please install ffmpeg properly or make a softlink to ./!"
  );
  process.exit(-1);
});

io.on("connection", function (socket) {
  let roomId = null;
  socket.emit("message", "Hello from mediarecorder-to-rtmp server!");
  socket.emit("message", "Please set rtmp destination before start streaming.");

  socket.on("join_room", function (m) {
    console.log(`joined`, m);
    socket.join(m);
    if (io.sockets.adapter.rooms[m]) {
      socket.to(m).emit("update_count", io.sockets.adapter.rooms[m].length);
    }
    roomId = m;
  });

  socket.on("chat_message", function (m) {
    if (roomId) {
      socket.emit(`send_message`, m);
      socket.to(roomId).emit(`send_message`, m);
    }
  });
  
  socket.on("switch_products", function (m) {
      socket.emit(`switch_products`, m);
      socket.to(roomId).emit(`switch_products`, m);
  });

  socket.on("update__viewers", function (m) {
    if (roomId) {
      socket.emit("update_count", io.sockets.adapter.rooms[roomId].length);
    }
  });

  var ffmpeg_process,
    feedStream = false;
  socket._rtmpDestination =
    "rtmp://broadcast.api.video/s/dc4d8d13-7899-4381-9e8b-bebc93c75f93";

  socket.on("setRtmpServer", function (m) {
    if (!m) {
      socket.emit("message", "no rtmp url");
      return;
    }
    socket._rtmpDestination = m;
  });

  //socket._vcodec='libvpx';//from firefox default encoder
  socket.on("config_vcodec", function (m) {
    if (typeof m != "string") {
      socket.emit("fatal", "input codec setup error.");
      return;
    }
    if (!/^[0-9a-z]{2,}$/.test(m)) {
      socket.emit("fatal", "input codec contains illegal character?.");
      return;
    } //for safety
    socket._vcodec = m;
  });

  socket.on("start", function (m) {
    if (ffmpeg_process || feedStream) {
      socket.emit("fatal", "stream already started.");
      return;
    }
    if (!socket._rtmpDestination) {
      socket.emit("fatal", "no destination given.");
      return;
    }
    var audioBitrate = parseInt(socket.handshake.query.audioBitrate);
    var audioEncoding = "22k";

    var ops = [
      "-i",
      "-",

      // video codec config: low latency, adaptive bitrate
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",

      // audio codec config: sampling frequency (11025, 22050, 44100), bitrate 64 kbits
      "-c:a",
      "aac",
      "-strict",
      "-2",
      "-ar",
      "44100",
      "-b:a",
      "64k",

      //force to overwrite
      "-y",

      // used for audio sync
      "-use_wallclock_as_timestamps",
      "1",
      "-async",
      "1",

      //'-filter_complex', 'aresample=44100', // resample audio to 44100Hz, needed if input is not 44100
      //'-strict', 'experimental',
      "-bufsize",
      "1000",
      "-f",
      "flv",

      socket._rtmpDestination,
    ];

    console.log("ops", ops);
    console.log(socket._rtmpDestination);
    ffmpeg_process = spawn("ffmpeg", ops);
    console.log("ffmpeg spawned");
    feedStream = function (data) {
      ffmpeg_process.stdin.write(data);
      //write exception cannot be caught here.
    };

    ffmpeg_process.stderr.on("data", function (d) {
      socket.emit("ffmpeg_stderr", "" + d);
    });
    ffmpeg_process.on("error", function (e) {
      console.log("child process error" + e);
      socket.emit("fatal", "ffmpeg error!" + e);
      feedStream = false;
      socket.disconnect();
    });
    ffmpeg_process.on("exit", function (e) {
      console.log("child process exit" + e);
      socket.emit("fatal", "ffmpeg exit!" + e);
      socket.disconnect();
    });
  });

  socket.on("binarystream", function (m) {
    if (!feedStream) {
      socket.emit("fatal", "rtmp not set yet.");
      ffmpeg_process.stdin.end();
      ffmpeg_process.kill("SIGINT");
      return;
    }
    feedStream(m);
  });
  socket.on("disconnect", function () {
    socket.leave(roomId);
    if (io.sockets.adapter.rooms[roomId]) {
      socket
        .to(roomId)
        .emit("update_count", io.sockets.adapter.rooms[roomId].length);
    }
    console.log("socket disconnected!");
    feedStream = false;
    if (ffmpeg_process)
      try {
        ffmpeg_process.stdin.end();
        ffmpeg_process.kill("SIGINT");
        console.log("ffmpeg process ended!");
      } catch (e) {
        console.warn("killing ffmoeg process attempt failed...");
      }
  });
  socket.on("error", function (e) {
    console.log("socket.io error:" + e);
  });
});

io.on("error", function (e) {
  console.log("socket.io error:" + e);
});

const port = process.env.PORT || 8080;

server.listen(port, function () {
  console.log(`https and websocket listening on port:${port}`);
});

process.on("uncaughtException", function (err) {
  // handle the error safely
  console.log(err);
  // Note: after client disconnect, the subprocess will cause an Error EPIPE, which can only be caught this way.
});
