import os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'  # Suprime los mensajes de TensorFlow
import tensorflow as tf
import json
from flask import Flask, request, jsonify
import numpy as np
import nltk
import random
import json
from nltk.stem import WordNetLemmatizer


app = Flask(__name__)

# Cargar modelo y datos C:/Proyecto de grado/VyCla-v03/vycla1/VyCla-v03/base-baileys-postgres/modelo/chatbot_model.h5
modelo = tf.keras.models.load_model("C:/Proyecto de grado/VyCla-v03/base-baileys-postgres/modelo/chatbot_model.h5")
lemmatizer = WordNetLemmatizer()

with open("datos/IntentsCT.json", encoding="utf-8") as file:
    data = json.load(file)


# Cargar listas de palabras y clases
with open("scripts/palabras.json", "r", encoding="utf-8") as f:
    palabras = json.load(f)

with open("scripts/clases.json", "r", encoding="utf-8") as f:
    clases = json.load(f)


def limpiar_texto(texto):
    tokens = nltk.word_tokenize(texto)
    tokens = [lemmatizer.lemmatize(w.lower()) for w in tokens]
    return tokens

def bag_of_words(texto, palabras):
    tokens = limpiar_texto(texto)
    bolsa = [0] * len(palabras)
    for t in tokens:
        for i, palabra in enumerate(palabras):
            if palabra == t:
                bolsa[i] = 1
    return np.array(bolsa)

def predecir_clase(texto, umbral=0.7):
    bow = bag_of_words(texto, palabras)
    res = modelo.predict(np.array([bow]))[0]
    indice = np.argmax(res)
    if res[indice] < umbral:
        return None  # No hay suficiente confianza
    return clases[indice]

def obtener_respuesta(clase):
    for intent in data["intents"]:
        if intent["tag"] == clase:
            return random.choice(intent["responses"])
    return "No entendí la pregunta."


@app.route("/chat", methods=["POST"])
def chatbot():
    try:
        datos = request.get_json()
        mensaje = datos.get("message", "")

        if not mensaje:
            return jsonify({
                "message": "No entendí la pregunta.",
                "tag": "no_entendido",
                "action": None,
                "capture": False
            })

        clase = predecir_clase(mensaje)
        if not clase:
            return jsonify({
                "message": "Lo siento, no comprendo tu solicitud. ¿Puedes reformular tu pregunta?",
                "tag": "no_entendido",
                "action": None,
                "capture": False
            })

        # Buscar la intención completa en el JSON
        intent = next((i for i in data["intents"] if i["tag"] == clase), None)
        
        if intent:
            return jsonify({
                "message": random.choice(intent["responses"]),
                "tag": intent["tag"],
                "action": intent.get("action"),
                "capture": intent.get("capture", False)
            })
        
        return jsonify({
            "message": "No entendí la pregunta.",
            "tag": "no_entendido",
            "action": None,
            "capture": False
        })
    except Exception as e:
        print(f"Error en el chatbot: {e}")
        return jsonify({
            "message": "Hubo un error al procesar tu solicitud.",
            "tag": "error",
            "action": None,
            "capture": False
        })
    
if __name__ == "__main__":
    app.run(port=5000, debug=True)