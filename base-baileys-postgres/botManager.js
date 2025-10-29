class BotManager {
    static provider = null;

    static init(provider) {
        BotManager.provider = provider;
        console.log('BotManager inicializado con provider:', provider ? 'Sí' : 'No');
    }

    // En botManager.js
    static async sendMessage(userId, message) {
        if (!BotManager.provider) {
            console.error('Provider no está inicializado en BotManager');
            return false;
        }
        
        try {
            console.log(`Intentando enviar mensaje a ${userId}`);
            
            // Asegurar que el userId tenga el formato correcto
            const formattedId = userId.includes('@') ? userId : `${userId}@s.whatsapp.net`;
            
            await BotManager.provider.sendText(formattedId, message);
            return true;
        } catch (error) {
            console.error(`Error enviando mensaje a ${userId}:`, error);
            return false;
        }
    }
}
module.exports = BotManager;