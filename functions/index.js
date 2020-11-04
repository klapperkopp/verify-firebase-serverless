const functions = require("firebase-functions");

// initialize cryptogrpahy
const crypto = require("crypto");
const bcrypt = require("bcrypt");

// initialize Vonage SDK
const Vonage = require("@vonage/server-sdk");
const vonage = new Vonage({
  apiKey: functions.config().vonage.api_key || "",
  apiSecret: functions.config().vonage.api_secret || "",
});

// initialize firebase SDK
const admin = require("firebase-admin");
admin.initializeApp(functions.config().firebase);
const db = admin.firestore();

// Verify Configuration
const VERIFY_WORKFLOW = 4; // 1 = SMS->TTS->TTS / 2 = SMS->TTS / 3 = TTS->TTS / 4 = SMS->SMS / 5 = SMS->TTS / 6 = SMS / 7 = TTS
const VERIFY_BRAND = "TARKOV"; // brand name displayed in the SMS text
const VERIFY_SENDER_ID = "BATTLESTATE"; // SMS Sender ID (from)
const VERIFY_LANGUAGE = "ru-ru"; // default is based on phone number country code, you can set those values: https://developer.nexmo.com/verify/guides/verify-languages
const VERIFY_CODE_LENGTH = 6; // must be 4 or 6
const VERIFY_PIN_EXPIRY = 300; // in seconds, minnimum 60, maximum 3600
const VERIFY_NEXT_EVENT_WAIT = 60; // wait time (seconds) between attempts to deliver the verification code. min 60, max 900

// REST Endpoint for Creating a User in Firebase DB
exports.createUser = functions.https.onRequest(async (request, response) => {
  // get username and phone number from request body, username could also be userID or any other identifier
  const { username, password, phone } = request.body;

  // encrypt password and phone number
  const encryptedPassword = encryptPassword(password);
  const { encryptedPhoneNumber, iv } = encryptPhoneNumber(password, phone);

  // create hashed phone number with SHA256
  const hash = crypto.createHash("sha256").update(phone).digest("hex");

  //check if user is banned and only allow account creation if he is not
  const isBanned = await checkBan(hash);
  if (isBanned) {
    response.send({ message: "User is banned. Cannot register.", error: true });
  } else {
    // send verify request for first registration
    vonage.verify.request(
      {
        number: phone,
        brand: VERIFY_BRAND,
        workflow: VERIFY_WORKFLOW,
        sender_id: VERIFY_SENDER_ID,
        lg: VERIFY_LANGUAGE,
        pin_expiry: VERIFY_PIN_EXPIRY,
        next_event_wait: VERIFY_NEXT_EVENT_WAIT,
        code_length: VERIFY_CODE_LENGTH,
      },
      (err, result) => {
        if (err) {
          // log if error on verification and respond with error
          functions.logger.error(err);
          response.send({ message: `Verification error: ${err}`, error: true });
        } else {
          // get verify request id if verify request was send successfully
          const verifyRequestId = result.request_id;
          functions.logger.info("request_id", verifyRequestId);
          // store user data and verify request id to cloud firestore DB
          const docRef = db.collection("users").doc(`${username}`);
          docRef
            .set({
              last_verify_request_id: verifyRequestId,
              last_verify_request_type: "registration",
              verified: false,
              hashed_phone: hash,
              encryptedPhoneNumber: encryptedPhoneNumber,
              encryptedPassword: encryptedPassword,
              iv,
            })
            .then((r) => {
              // send response including the verify request ID
              response.send({
                message: `User created: ${docRef.id}`,
                verifyRequestId: verifyRequestId,
              });
              return;
            })
            .catch((e) => {
              throw e;
            });
        }
      }
    );
  }
});

// REST endpoint which is called when the user enters the verification code
exports.verifyUser = functions.https.onRequest(async (request, response) => {
  const { request_id, code } = request.body;
  // get type of request from DB
  const usersRef = db.collection("users");
  const snapshot = await usersRef
    .where("last_verify_request_id", "==", request_id)
    .limit(1)
    .get();

  if (snapshot.empty) {
    functions.logger.error("No user found with this Verify Request ID");
    response.send({
      message: "No user found with this Verify Request ID",
      error: true,
    });
  }

  let type = null;
  let docRef = null;

  snapshot.forEach((doc) => {
    type = doc.data().last_verify_request_type;
    docRef = doc.ref;
  });

  // check verify request
  vonage.verify.check(
    {
      request_id,
      code,
    },
    (err, result) => {
      if (err) {
        functions.logger.error(err);
        response.send({
          message: `Verification result error: ${err}`,
          error: true,
        });
      } else {
        functions.logger.info(result);
        if (result.status !== "0") {
          response.send({
            message: `Verification status is not successful (not status 0): ${result.error_text}`,
            error: true,
          });
        }
        if (type === "registration") {
          // modify user verified flag
          const usersRef = db.collection("users");
          functions.logger.info(usersRef);

          docRef
            .update({ verified: true })
            .then(() => {
              response.send({
                message: `User successfully verified for registration: ${JSON.stringify(
                  result
                )}`,
                error: false,
              });
              return;
            })
            .catch((e) =>
              response.send({
                message: `Error updating docRef: ${e}`,
                error: true,
              })
            );
        } else {
          response.send({
            message: `Successfully logged in: ${JSON.stringify(result)}`,
            error: false,
          });
        }
      }
    }
  );
});

// REST endpoint for logging in user
exports.loginUser = functions.https.onRequest(async (request, response) => {
  const { username, password } = request.body;

  // fetch user data from database
  const doc = await db.collection("users").doc(`${username}`).get();
  const encryptedPhoneNumber = doc.data().encryptedPhoneNumber;
  const { encryptedPassword, iv, verified } = doc.data();

  // check if password is correct
  const isPasswordCorrect = checkPassword(password, encryptedPassword);

  // decrypt phone number with password and salt (iv)
  const decryptedPhoneNumber = decryptPhoneNumber(
    password,
    encryptedPhoneNumber,
    iv
  );

  // eslint-disable-next-line promise/always-return
  // check if user has been verified on registration and password is correct
  if (verified && isPasswordCorrect) {
    // initialize request ID
    let verifyRequestId = null;

    // send verify request
    vonage.verify.request(
      {
        number: decryptedPhoneNumber,
        brand: VERIFY_BRAND,
        workflow: VERIFY_WORKFLOW,
        sender_id: VERIFY_SENDER_ID,
        lg: VERIFY_LANGUAGE,
        pin_expiry: VERIFY_PIN_EXPIRY,
        next_event_wait: VERIFY_NEXT_EVENT_WAIT,
        code_length: VERIFY_CODE_LENGTH,
      },
      (err, result) => {
        if (err) {
          // log if verify request error and respond
          functions.logger.error(err);
          response.send({ message: `Verification error: ${err}`, error: true });
        } else {
          // if successful, log and save verify Request ID
          verifyRequestId = result.request_id;
          functions.logger.info("Verify request_id: ", verifyRequestId);

          // save verify request ID to database
          doc.ref
            .update({
              last_verify_request_id: verifyRequestId,
              last_verify_request_type: "login",
            })
            .then(() => {
              // if saved, send REST api response with success message
              response.send({
                message: `You are logged in after you enter your SMS Code that was sent. Verify ID: ${verifyRequestId}`,
                erro: true,
              });
              return null;
            })
            .catch((e) => {
              // if failed, cancel verify request
              vonage.verify.control(
                {
                  request_id: verifyRequestId,
                  cmd: "cancel",
                },
                (err, res) => {
                  if (err) {
                    functions.logger.error("Verify cancel failed: ", err);
                    // send REST api response with error
                    response.send({
                      message: `Failed to store verify request ID to DB and failed to cancel Verify request. ${verifyRequestId}`,
                      error: true,
                    });
                  } else {
                    functions.logger.error("Verify cancelled: ", res);
                    // send REST api response with error
                    response.send({
                      message: `Cancelled the verify request, because of error when storing verify request ID to DB: ${e}`,
                      error: true,
                    });
                  }
                }
              );
            });
        }
      }
    );
  } else {
    response.send({
      message:
        "You are NOT logged in. Please Verify your number first or provide the correct password.",
      error: true,
    });
  }
});

// REST endpoint for banning a a phone number hash
exports.banPhoneHash = functions.https.onRequest(async (request, response) => {
  const { phoneHash } = request.body;
  await db.collection("bannedPhoneHashes").doc(`${phoneHash}`).set({});
  response.send({ message: `Phone Number banned: ${phoneHash}`, error: false });
});

// REST endpoint for remove the ban of a phone number hash
exports.removeBan = functions.https.onRequest(async (request, response) => {
  const { phoneHash } = request.body;
  await db.collection("bannedPhoneHashes").doc(`${phoneHash}`).delete();
  response.send({
    message: `Phone Number removed from ban list: ${phoneHash}`,
    error: false,
  });
});

// REST endpoint for checking if a user is banned
exports.checkIfBanned = functions.https.onRequest(async (request, response) => {
  const { phoneHash } = request.body;
  const isBanned = await checkBan(phoneHash);
  if (isBanned) {
    response.send({
      message: "This phone number is currently banned.",
      isBanned: true,
      error: false,
    });
  } else if (checkBan(phoneHash) === null) {
    response.send({
      message: "Error checking if this phone number is currently banned.",
      error: true,
    });
  } else {
    response.send({
      message: "This phone number is currently NOT banned.",
      isBanned: false,
      error: false,
    });
  }
});

// checks if a hashed phone number is stored in the database as banned
function checkBan(phoneHash) {
  return db
    .collection("bannedPhoneHashes")
    .doc(`${phoneHash}`)
    .get()
    .then((snapshot) => {
      if (snapshot.exists) {
        return true;
      } else {
        return false;
      }
    })
    .catch((e) => functions.logger.error(e));
}

// function to encrypt password and phone number
function encryptPassword(password) {
  // salt for password
  const salt = bcrypt.genSaltSync(10);

  // take salt and hash the password with it
  const encryptedPassword = bcrypt.hashSync(password, salt);

  // return encrypted (it is actually hashed) password and phone number
  return encryptedPassword;
}

function encryptPhoneNumber(password, phoneNumber) {
  // generate iv for phone number
  const iv = crypto.randomBytes(16);
  // generate key for phone number
  const key = crypto.scryptSync(password, "salt", 24);

  // use the password to hash the phone number
  // this way we can only decrpyt the phone number with correct user password on login
  const cipher = crypto.createCipheriv("aes-192-cbc", key, iv);
  const encryptedPhoneNumber =
    cipher.update(phoneNumber, "utf8", "hex") + cipher.final("hex");
  // return encrypted (hashed) phone number and iv
  return { encryptedPhoneNumber, iv };
}

// function to decrypt the phone number after user login with password
function decryptPhoneNumber(password, encryptedPhoneNumber, iv) {
  const key = crypto.scryptSync(password, "salt", 24);
  var decipher = crypto.createDecipheriv("aes-192-cbc", key, iv);
  var decryptedPhoneNumber =
    decipher.update(encryptedPhoneNumber, "hex", "utf8") + decipher.final();
  return decryptedPhoneNumber;
}

// function to check if password is correct
function checkPassword(password, hash) {
  const isSame = bcrypt.compareSync(password, hash);
  return isSame;
}
