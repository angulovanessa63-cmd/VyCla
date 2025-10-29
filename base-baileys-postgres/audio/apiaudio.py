from flask import Flask, request, jsonify
import os
import requests
import whisper
from pydub import AudioSegment
app = Flask(__name__)
# Cargar modelo Whisper una sola vez
modelo_whisper = whisper.load_model("base")

def convertir_a_wav(ruta_entrada, ruta_salida=None):
    try:
        if not os.path.exists(ruta_entrada):
            raise FileNotFoundError(f"No se encontró el archivo: {ruta_entrada}")

        if not ruta_salida:
            ruta_salida = ruta_entrada.rsplit(".", 1)[0] + ".wav"

        audio = AudioSegment.from_file(ruta_entrada)
        audio.export(ruta_salida, format="wav")
        print(f"✅ Audio convertido a WAV en: {ruta_salida}")
        return ruta_salida

    except Exception as e:
        print(f"❌ Error al convertir a WAV: {e}")
        raise

def transcribir_audio_local(ruta_audio_oga):
    try:
        ruta_audio_wav = convertir_a_wav(ruta_audio_oga)
        result = modelo_whisper.transcribe(ruta_audio_wav)
        texto = result["text"].strip()
        print(f"📝 Texto transcrito: '{texto}'")

        return texto if texto else "No se pudo transcribir."

    except Exception as e:
        print(f"❌ Error al transcribir audio: {e}")
        return "No se pudo transcribir."
    
@app.route("/audio", methods=["POST"])
def recibir_audio():
    try:
        if "audio" not in request.files:
            return jsonify({"error": "No se envió el archivo"}), 400

        audio_file = request.files["audio"]
        audio_dir = os.path.join(os.getcwd(), "audios")
        if not os.path.exists(audio_dir):
            os.makedirs(audio_dir)

        audio_path = os.path.join(audio_dir, "temp.oga")
        audio_file.save(audio_path)

        texto = transcribir_audio_local(audio_path)
        return jsonify({"transcripcion": texto})

    except Exception as e:
        import traceback
        traceback.print_exc()  # Esto imprime la traza completa en consola
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(port=5002, debug=True)