#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Local testing example:
// const char* serverUrl = "http://172.17.148.27:3000";

// Render example:
// const char* serverUrl = "https://your-render-app.onrender.com";

const char* serverUrl = "http://172.22.75.144:3000";

const int servoPin = 18;
const int irSensorPin = 34;

Servo gateServo;

int coinsToDispense = 0;
bool isDispensing = false;

String activeTxnId = "";

void setup() {
  Serial.begin(115200);
  delay(1000);

  gateServo.setPeriodHertz(50);
  gateServo.attach(servoPin, 500, 2400);
  gateServo.write(0);

  pinMode(irSensorPin, INPUT);

  connectToWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectToWiFi();
  }

  if (!isDispensing) {
    checkLatestPayment();
  }

  delay(2000);
}

void connectToWiFi() {
  Serial.print("Connecting WiFi: ");
  Serial.println(ssid);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\n✅ WiFi Connected!");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());
}

void checkLatestPayment() {
  HTTPClient http;
  String url = String(serverUrl) + "/latest-payment";

  Serial.println("Polling backend...");
  http.begin(url);
  int httpResponseCode = http.GET();

  if (httpResponseCode == 200) {
    String payload = http.getString();

    StaticJsonDocument<256> doc;
    DeserializationError error = deserializeJson(doc, payload);

    if (error) {
      Serial.print("JSON Parse Failed: ");
      Serial.println(error.c_str());
      http.end();
      return;
    }

    bool paid = doc["paid"];
    int amount = doc["amount"];
    const char* txnid = doc["txnid"];

    if (paid && amount > 0 && txnid != nullptr) {
      Serial.printf("💰 Payment Found: ₹%d\n", amount);
      Serial.print("TXNID: ");
      Serial.println(txnid);

      coinsToDispense = amount;  // ₹1 coins
      activeTxnId = String(txnid);

      dispenseCoins();
    }
  } else {
    Serial.print("HTTP Get Failed, Code: ");
    Serial.println(httpResponseCode);
  }

  http.end();
}

void dispenseCoins() {
  isDispensing = true;
  int dispensedCount = 0;

  while (dispensedCount < coinsToDispense) {
    Serial.printf("Dispensing coin %d of %d...\n",
                  dispensedCount + 1, coinsToDispense);

    // Open gate
    gateServo.write(90);
    delay(400);

    // Wait for IR detection
    unsigned long startTime = millis();
    bool coinDetected = false;

    while (millis() - startTime < 3000) {
      // Most IR modules give LOW when object detected
      if (digitalRead(irSensorPin) == LOW) {
        coinDetected = true;
        break;
      }
      delay(5);
    }

    // Close gate
    gateServo.write(0);
    delay(700);

    if (coinDetected) {
      dispensedCount++;
      Serial.println("✅ Coin Delivered");
      delay(200);
    } else {
      Serial.println("❌ ERROR: Coin not detected (jam/empty)");
      break;
    }
  }

  if (dispensedCount == coinsToDispense) {
    Serial.println("🎉 Dispensing complete. Marking used...");
    markUsed(activeTxnId);
  } else {
    Serial.println("⚠️ Dispensing interrupted due to error.");
  }

  isDispensing = false;
}

void markUsed(String txnid) {
  HTTPClient http;
  String url = String(serverUrl) + "/mark-used";

  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"txnid\":\"" + txnid + "\"}";
  int httpResponseCode = http.POST(body);

  if (httpResponseCode == 200) {
    Serial.println("✅ Backend updated: Payment marked dispensed.");
  } else {
    Serial.print("❌ Failed to mark used, HTTP: ");
    Serial.println(httpResponseCode);
  }

  http.end();
}
