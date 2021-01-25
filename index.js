const dgram = require("dgram");
const crc = require("crc");
const GamePad = require("node-gamepad");

const onControllerUpdate = (controllerState) => {
  console.log("onControllerUpdate:", controllerState);
  Report(controllerState);
};

const controller = new GamePad("logitech/dualaction", {
  callback: onControllerUpdate,
  debug: true,
});
controller.connect();

// UDP portion based on https://github.com/denismr/iOSGyroForCemuhook
const server = dgram.createSocket("udp4");

function char(a) {
  return a.charCodeAt(0);
}

const maxProtocolVer = 1001;
const MessageType = {
  DSUC_VersionReq: 0x100000,
  DSUS_VersionRsp: 0x100000,
  DSUC_ListPorts: 0x100001,
  DSUS_PortInfo: 0x100001,
  DSUC_PadDataReq: 0x100002,
  DSUS_PadDataRsp: 0x100002,
};
const serverID = 1234;
console.log(`serverID: ${serverID}`);

var connectedClient = null;
var lastRequestAt = 0;
var packetCounter = 0;
const clientTimeoutLimit = 5000;

///////////////////////////////////////////////////

function BeginPacket(data) {
  let index = 0;
  data[index++] = char("D");
  data[index++] = char("S");
  data[index++] = char("U");
  data[index++] = char("S");

  data.writeUInt16LE(maxProtocolVer, index, true);
  index += 2;

  data.writeUInt16LE(data.length - 16, index, true);
  index += 2;

  data.writeUInt32LE(0, index, true);
  index += 4;

  data.writeUInt32LE(serverID, index, true);
  index += 4;

  return index;
}

function FinishPacket(data) {
  data.writeUInt32LE(crc.crc32(data), 8, true);
}

function SendPacket(client, data) {
  let buffer = Buffer.alloc(data.length + 16);
  let index = BeginPacket(buffer);
  buffer.fill(data, index);
  FinishPacket(buffer);
  server.send(buffer, client.port, client.address, (error, bytes) => {
    if (error) {
      console.log("Send packet error");
      console.log(error.message);
    } else if (bytes !== buffer.length) {
      console.log(
        `failed to completely send all of buffer. Sent: ${bytes}. Buffer length: ${buffer.length}`
      );
    }
  });
}

///////////////////////////////////////////////////

server.on("error", (err) => {
  console.log(`server error:\n${err.stack}`);
  server.close();
});

server.on("listening", () => {
  const address = server.address();
  console.log(
    `UDP Pad motion data provider listening ${address.address}:${address.port}`
  );
});

server.on("message", (data, rinfo) => {
  if (
    !(
      data[0] === char("D") &&
      data[1] === char("S") &&
      data[2] === char("U") &&
      data[3] === char("C")
    )
  )
    return;
  let index = 4;

  let protocolVer = data.readUInt16LE(index);
  index += 2;

  let packetSize = data.readUInt16LE(index);
  index += 2;

  let receivedCrc = data.readUInt32LE(index);
  data[index++] = 0;
  data[index++] = 0;
  data[index++] = 0;
  data[index++] = 0;

  let computedCrc = crc.crc32(data);

  if (receivedCrc !== computedCrc) {
    console.error("crc error");
    return;
  }

  let clientId = data.readUInt32LE(index);
  index += 4;
  let msgType = data.readUInt32LE(index);
  index += 4;

  if (msgType == MessageType.DSUC_VersionReq) {
    console.log("Version request ignored.");
  } else if (msgType == MessageType.DSUC_ListPorts) {
    // console.log("List ports request.");
    let numOfPadRequests = data.readInt32LE(index);
    index += 4;
    for (let i = 0; i < numOfPadRequests; i++) {
      let requestIndex = data[index + i];
      if (requestIndex !== 0) continue;
      let outBuffer = Buffer.alloc(16);
      outBuffer.writeUInt32LE(MessageType.DSUS_PortInfo, 0, true);
      let outIndex = 4;
      outBuffer[outIndex++] = 0x00; // pad id
      outBuffer[outIndex++] = 0x02; // state (connected)
      outBuffer[outIndex++] = 0x03; // model (generic)
      outBuffer[outIndex++] = 0x01; // connection type (usb)
      // mac address
      for (let j = 0; j < 5; j++) {
        outBuffer[outIndex++] = 0;
      }
      outBuffer[outIndex++] = 0xff; // 00:00:00:00:00:FF
      outBuffer[outIndex++] = 0xef; // battery (charged)
      outBuffer[outIndex++] = 0; // dunno (probably "is active")
      SendPacket(rinfo, outBuffer);
    }
  } else if (msgType == MessageType.DSUC_PadDataReq) {
    let flags = data[index++];
    let idToRRegister = data[index++];
    let macToRegister = ["", "", "", "", "", ""];
    for (let i = 0; i < macToRegister.length; i++, index++) {
      macToRegister[i] = `${data[index] < 15 ? "0" : ""}${data[index].toString(
        16
      )}`;
    }
    macToRegister = macToRegister.join(":");

    // There is only one controller, so
    if (
      flags == 0 ||
      (idToRRegister == 0 && flags & (0x01 !== 0)) ||
      (macToRegister == "00:00:00:00:00:ff" && flags & (0x02 !== 0))
    ) {
      connectedClient = rinfo;
      lastRequestAt = Date.now();
    }
  }
});

function Report(controllerState) {
  let client = connectedClient;
  if (client === null || Date.now() - lastRequestAt > clientTimeoutLimit)
    return;

  let outBuffer = Buffer.alloc(100);
  let outIndex = BeginPacket(outBuffer);
  outBuffer.writeUInt32LE(MessageType.DSUS_PadDataRsp, outIndex, true);
  outIndex += 4;

  outBuffer[outIndex++] = 0x00; // pad id
  outBuffer[outIndex++] = 0x02; // state (connected)
  outBuffer[outIndex++] = 0x02; // model (generic)
  outBuffer[outIndex++] = 0x01; // connection type (usb)

  // mac address
  for (let i = 0; i < 5; i++) {
    outBuffer[outIndex++] = 0x00;
  }
  outBuffer[outIndex++] = 0xff; // 00:00:00:00:00:FF

  outBuffer[outIndex++] = 0xef; // battery (charged)
  outBuffer[outIndex++] = 0x01; // is active (true)

  outBuffer.writeUInt32LE(packetCounter++, outIndex, true);
  outIndex += 4;

  let dpad = 0x00;
  if (controllerState.dpadLeft) {
    dpad = dpad | (1 << 7);
  }
  if (controllerState.dpadDown) {
    dpad = dpad | (1 << 6);
  }
  if (controllerState.dpadRight) {
    dpad = dpad | (1 << 5);
  }
  if (controllerState.dpadUp) {
    dpad = dpad | (1 << 4);
  }
  if (controllerState.b10) {
    dpad = dpad | (1 << 3);
  }
  if (controllerState.b9) {
    dpad = dpad | (1 << 0);
  }

  let buttons = 0x00;
  if (controllerState.b1) {
    buttons = buttons | (1 << 7);
  }
  if (controllerState.b2) {
    buttons = buttons | (1 << 6);
  }
  if (controllerState.b3) {
    buttons = buttons | (1 << 5);
  }
  if (controllerState.b4) {
    buttons = buttons | (1 << 4);
  }
  if (controllerState.b6) {
    buttons = buttons | (1 << 3);
  }
  if (controllerState.b5) {
    buttons = buttons | (1 << 2);
  }
  if (controllerState.b8) {
    buttons = buttons | (1 << 1);
  }
  if (controllerState.b7) {
    buttons = buttons | (1 << 0);
  }

  outBuffer[outIndex] = dpad; // left, down, right, up, options, R3, L3, share
  outBuffer[++outIndex] = buttons; // square, cross, circle, triangle, r1, l1, r2, l2
  outBuffer[++outIndex] = 0x00; // PS
  outBuffer[++outIndex] = 0x00; // Touch

  outBuffer[++outIndex] = controllerState.left.x; // position left x
  outBuffer[++outIndex] = controllerState.left.y; // position left y
  outBuffer[++outIndex] = controllerState.right.x; // position right x
  outBuffer[++outIndex] = controllerState.right.y; // position right y

  outBuffer[++outIndex] = controllerState.dpadLeft ? 0xff : 0x00; // dpad left
  outBuffer[++outIndex] = controllerState.dpadDown ? 0xff : 0x00; // dpad down
  outBuffer[++outIndex] = controllerState.dpadRight ? 0xff : 0x00; // dpad right
  outBuffer[++outIndex] = controllerState.dpadUp ? 0xff : 0x00; // dpad up

  outBuffer[++outIndex] = controllerState.b1 ? 0xff : 0x00; // square
  outBuffer[++outIndex] = controllerState.b2 ? 0xff : 0x00; // cross
  outBuffer[++outIndex] = controllerState.b3 ? 0xff : 0x00; // circle
  outBuffer[++outIndex] = controllerState.b4 ? 0xff : 0x00; // triange

  outBuffer[++outIndex] = controllerState.b6 ? 0xff : 0x00; // r1
  outBuffer[++outIndex] = controllerState.b5 ? 0xff : 0x00; // l1

  outBuffer[++outIndex] = controllerState.b8 ? 0xff : 0x00; // r2
  outBuffer[++outIndex] = controllerState.b7 ? 0xff : 0x00; // l2

  outIndex++;

  //   outBuffer[outIndex++] = 0x00; // track pad first is active (false)
  //   outBuffer[outIndex++] = 0x00; // track pad first id
  //   outBuffer.writeUInt16LE(0x0000, outIndex, true); // trackpad first x
  //   outIndex += 2;
  //   outBuffer.writeUInt16LE(0x0000, outIndex, true); // trackpad first y
  //   outIndex += 2;

  //   outBuffer[outIndex++] = 0x00; // track pad second is active (false)
  //   outBuffer[outIndex++] = 0x00; // track pad second id
  //   outBuffer.writeUInt16LE(0x0000, outIndex, true); // trackpad second x
  //   outIndex += 2;
  //   outBuffer.writeUInt16LE(0x0000, outIndex, true); // trackpad second y
  //   outIndex += 2;

  //   outBuffer.writeUInt32LE(motionTimestamp.low, outIndex, true);
  //   outIndex += 4;
  //   outBuffer.writeUInt32LE(motionTimestamp.high, outIndex, true);
  //   outIndex += 4;

  //   outBuffer.writeFloatLE(accelerometer.x, outIndex, true);
  //   outIndex += 4;
  //   outBuffer.writeFloatLE(accelerometer.y, outIndex, true);
  //   outIndex += 4;
  //   outBuffer.writeFloatLE(accelerometer.z, outIndex, true);
  //   outIndex += 4;

  //   outBuffer.writeFloatLE(gyro.x, outIndex, true);
  //   outIndex += 4;
  //   outBuffer.writeFloatLE(gyro.y, outIndex, true);
  //   outIndex += 4;
  //   outBuffer.writeFloatLE(gyro.z, outIndex, true);
  //   outIndex += 4;

  FinishPacket(outBuffer);
  server.send(outBuffer, client.port, client.address, (error, bytes) => {
    if (error) {
      console.log("Send packet error");
      console.log(error.message);
    } else if (bytes !== outBuffer.length) {
      console.log(
        `failed to completely send all of buffer. Sent: ${bytes}. Buffer length: ${outBuffer.length}`
      );
    }
  });
}

server.bind(26760);
