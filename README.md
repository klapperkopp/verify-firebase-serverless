# Vonage Verify API & Firebase Cloud Functions

## Setup

1. Create a Firebase Project using the [Firebase Console](https://console.firebase.google.com/)
2. Enable Billing on your project by switching to the Blaze plan
3. Enable Cloud Firestore by going to `https://console.firebase.google.com/project/YOUR_PROJECT_NAME/firestore`
4. Clone or download this repo and open the main directory (`cd verify-firebase-serverless`).
5. You must have the Firebase CLI installed. If you don't have it install it with `npm install -g firebase-tools` and then configure it with `firebase login`
6. Configure the CLI locally by using `firebase use --add` and select your project in the list
7. Install dependencies locally by running: `cd functions && npm i && cd -`
8. Adjust the configuration constants for Verify in `functions/index.js` according to your needs

## Deploy and test

### Test Locally

1. Copy example runtimeconfig `cp .runtimeconfig.json.example .runtimeconfig.json` and enter your Vonage API key and secret (only needed for local testing of functions)
2. `firebase serve --only functions`

### Deploy and test on production

1. To set Firebase Environment variables, run `firebase functions:config:set vonage.api_key="YOUR_VONAGE_API_KEY" vonage.api_secret="YOUR_VONAGE_API_SECRET"` (you only need to do this once)
2. Run `firebase deploy`

## API Endpoints

### createUser

Create a user from this endpoint. The user will be stored in Cloud Firestore. Phone number and password will be stored in hashed form.

Sample Request:

```
{
    "username": "testuser",
    "phone": "PHONE_NUMBER_IN_E164_FORMAT (e.g. 49151123456789)",
    "password": "password"
}
```
Sample Response:
```
{
    "message": "User created: testuser",
    "verifyRequestId": "VERIFY_REQUEST_ID"
}
```

### verifyUser

Use this endpoint to check the Verification PIN that has been sent to the user. You can call this after the user enters the PIN code into your frontend.

If the PIN is a registration PIN Code then the user flash "verified" will be set to true in Cloud Firestore, if the PIN Code was entered correctly. If it was a login code, you will get a success message saying that you are successfully logged in.

Sample Request:

```
{
    "verifyRequestId": "VERIFY_REQUEST_ID",
    "code": "USER_PIN_CODE"
}
```
Sample Response after Registration:
```
{
    "message": "User successfully verified for registration: {\"request_id\":\"VERIFY_REQUEST_ID\",\"status\":\"0\",\"event_id\":\"VERIFY_EVENT_ID\",\"price\":\"0.01\",\"currency\":\"EUR\",\"estimated_price_messages_sent\":\"0.01\"}",
    "verificationResult": "REGISTRATION_SUCCESS",
    "verifyRequestId": "VERIFY_REQUEST_ID",
    "error": false
}
```
Sample Response after Login:
```
{
    "message": "Successfully logged in: {\"request_id\":\"VERIFY_REQUEST_ID\",\"status\":\"0\",\"event_id\":\"VERIFY_EVENT_ID\",\"price\":\"0.01\",\"currency\":\"EUR\",\"estimated_price_messages_sent\":\"0.01\"}",
    "verificationResult": "LOGIN_SUCCESS",
    "verifyRequestId": "VERIFY_REQUEST_ID",
    "error": false
}
```

### loginUser

Login a user. If the password is correct, this will automatically send an SMS PIN Code to the users phone number, which can then be checked with the _verifyUser_ API endpoint to log the user in.

Sample Request:

```
{
    "username": "testuser",
    "password": "password"
}
```
Sample Response:
```
{
    "message": "You are logged in after you enter your SMS Code that was sent. Verify ID: 49c6f20a3cf74970b02c580b2b31ecaa",
    "verifyRequestId": "VERIFY_REQUEST_ID",
    "error": false
}
```

### banPhoneHash

Ban a users hashed phone number (which can be taken from the user record in the Cloud Firestore).

Sample Request:

```
{
    "phoneHash": "HASHED_PHONE_NUMBER"
}
```
Sample Response:
```
{
    "message": "Phone Number banned: PHONE_NUMBER_HASH",
    "error": false
}
```


### removeBan

Remove a banned user phone hash from the list.

Sample Request:

```
{
    "phoneHash": "HASHED_PHONE_NUMBER"
}
```
Sample Response:
```
{
    "message": "Phone Number removed from ban list: PHONE_NUMBER_HASH",
    "error": false
}
```

### checkIfBanned

Check at any time if a users hashed phone number has been banned. Even after the user is deleted, this will still be available if he tries to register again.

Sample Request:

```
{
    "phoneHash": "HASHED_PHONE_NUMBER"
}
```

Sample Response:

```
{
    "message": "This phone number is currently banned.",
    "isBanned": true,
    "error": false
}
```
