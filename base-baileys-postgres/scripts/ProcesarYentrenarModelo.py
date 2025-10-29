import os
import json
import nltk
import numpy as np
import random
import tensorflow as tf
from nltk.corpus import stopwords
from nltk.stem import WordNetLemmatizer
from flask import Flask, request, jsonify

# Descargar recursos necesarios
nltk.download('punkt')
nltk.download('wordnet')
nltk.download('stopwords')

# Obtener la ruta del directorio del script actual
BASE_DIR = os.path.dirname(os.path.dirname(__file__))

# Cargar datos desde el archivo JSON
ruta_json = os.path.join(BASE_DIR, "datos", "IntentsCT.json")
with open(ruta_json, encoding="utf-8") as file:
    intents = json.load(file)

lemmatizer = WordNetLemmatizer()
stop_words = set(stopwords.words('spanish'))

# Función para limpiar texto
def limpiar_texto(texto):
    tokens = nltk.word_tokenize(texto.lower())
    tokens = [lemmatizer.lemmatize(w) for w in tokens if w.isalnum() and w not in stop_words]
    return tokens

# Preprocesamiento de datos
words = []
classes = []
documents = []
ignore_words = ["?", "!", ".", ","]

for intent in intents["intents"]:
    for pattern in intent["patterns"]:
        word_list = limpiar_texto(pattern)  # Aplicar limpieza de texto
        words.extend(word_list)
        documents.append((word_list, intent["tag"]))
        if intent["tag"] not in classes:
            classes.append(intent["tag"])

words = sorted(set(words))
classes = sorted(set(classes))

# Guardar las listas en archivos JSON
import json

with open("palabras.json", "w", encoding="utf-8") as f:
    json.dump(words, f)

with open("clases.json", "w", encoding="utf-8") as f:
    json.dump(classes, f)

# Convertir datos a formato de entrenamiento
training = []
output_empty = [0] * len(classes)

for doc in documents:
    bag = [1 if w in doc[0] else 0 for w in words]
    output_row = list(output_empty)
    output_row[classes.index(doc[1])] = 1
    training.append([bag, output_row])

random.shuffle(training)
training = np.array(training, dtype=object)

train_x = np.array(list(training[:, 0]))
train_y = np.array(list(training[:, 1]))

# Crear modelo de red neuronal
model = tf.keras.Sequential([
    tf.keras.layers.Dense(128, input_shape=(len(train_x[0]),), activation="relu"),
    tf.keras.layers.Dropout(0.5),
    tf.keras.layers.Dense(64, activation="relu"),
    tf.keras.layers.Dropout(0.5),
    tf.keras.layers.Dense(len(train_y[0]), activation="softmax")
])

model.compile(loss="categorical_crossentropy", optimizer="adam", metrics=["accuracy"])

# Entrenar el modelo con validación
history = model.fit(
    train_x,
    train_y,
    epochs=100,
    batch_size=5,
    validation_split=0.2,  
    verbose=1
)
import matplotlib.pyplot as plt

# Gráfica de exactitud 
plt.figure(figsize=(8, 5))
plt.plot(history.history['accuracy'], label='Entrenamiento')
plt.plot(history.history['val_accuracy'], label='Validación')
plt.title('Exactitud del modelo')
plt.xlabel('Épocas')
plt.ylabel('Exactitud')
plt.legend()
plt.grid(True)
plt.show()

# Gráfica de pérdida 
plt.figure(figsize=(8, 5))
plt.plot(history.history['loss'], label='Entrenamiento')
plt.plot(history.history['val_loss'], label='Validación')
plt.title('Pérdida del modelo')
plt.xlabel('Épocas')
plt.ylabel('Pérdida')
plt.legend()
plt.grid(True)
plt.show()


# Guardar el modelo en la carpeta "modelo"
ruta_modelo = os.path.join(BASE_DIR, "modelo", "chatbot_model.h5")

model.save(ruta_modelo)
print(f"✅ Modelo entrenado y guardado en: {ruta_modelo}")

# Inicializar Flask
app = Flask(__name__)

# Cargar modelo entrenado y datos necesarios
model = tf.keras.models.load_model(ruta_modelo)
intents = json.load(open(ruta_json, encoding="utf-8"))

# Función para preprocesar mensajes del usuario
def preprocess_message(message):
    message_words = limpiar_texto(message)  # Aplicar limpieza de texto
    bag = [1 if w in message_words else 0 for w in words]
    return np.array([bag])

# Ruta para recibir mensajes
@app.route("/chat", methods=["POST"])
def chat():
    try:
        data = request.get_json()
        message = data["message"]
        
        input_data = preprocess_message(message)
        result = model.predict(input_data)
        tag = classes[np.argmax(result)]

        for intent in intents["intents"]:
            if intent["tag"] == tag:
                response = random.choice(intent["responses"])
                return jsonify({"response": response})
        
        return jsonify({"response": "Lo siento, no entiendo tu pregunta."})
    
    except Exception as e:
        return jsonify({"response": f"Error: {str(e)}"}), 500

# Iniciar Flask en el puerto 5000
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
