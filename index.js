const fs = require("fs");
const express = require("express");
const Alexa = require("ask-sdk-core");
const { ExpressAdapter } = require("ask-sdk-express-adapter");

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();

const credencialPath = "/etc/secrets/firebase-service-account.json";
const userUid = process.env.USER_UID;

if (!fs.existsSync(credencialPath)) {
  throw new Error(
    "Arquivo firebase-service-account.json não encontrado no Render."
  );
}

if (!userUid) {
  throw new Error("Variável USER_UID não configurada no Render.");
}

const serviceAccount = JSON.parse(
  fs.readFileSync(credencialPath, "utf8")
);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

function formatarDinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === "LaunchRequest";
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "Olá! Eu sou a Aurora, assistente do Minha Vida Financeira. " +
        "Você pode pedir seu saldo ou um resumo financeiro."
      )
      .reprompt("O que você deseja consultar?")
      .getResponse();
  },
};

const ConsultarSaldoIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "ConsultarSaldoIntent"
    );
  },

  async handle(handlerInput) {
    /*
      Este caminho é provisório:
      usuarios/{UID}

      Depois vamos ajustar conforme a estrutura real do seu Firestore.
    */
    const usuarioRef = db.collection("usuarios").doc(userUid);
    const usuarioDoc = await usuarioRef.get();

    if (!usuarioDoc.exists) {
      return handlerInput.responseBuilder
        .speak(
          "A conexão com o Firebase funcionou, mas ainda não encontrei " +
          "o documento do seu usuário no Firestore."
        )
        .getResponse();
    }

    const dados = usuarioDoc.data();
    const saldo = Number(dados.saldo || 0);

    return handlerInput.responseBuilder
      .speak(`Seu saldo atual é de ${formatarDinheiro(saldo)}.`)
      .getResponse();
  },
};

const ResumoFinanceiroIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "ResumoFinanceiroIntent"
    );
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "A conexão com a Aurora está funcionando. " +
        "Agora estamos conectando os dados reais do Firestore."
      )
      .getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "AMAZON.HelpIntent"
    );
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "Você pode dizer: qual é meu saldo, ou faça um resumo financeiro."
      )
      .reprompt("O que deseja saber?")
      .getResponse();
  },
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    const tipo = Alexa.getRequestType(handlerInput.requestEnvelope);
    const intent = Alexa.getIntentName(handlerInput.requestEnvelope);

    return (
      tipo === "IntentRequest" &&
      (intent === "AMAZON.CancelIntent" ||
        intent === "AMAZON.StopIntent")
    );
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak("Até logo!")
      .getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },

  handle(handlerInput, error) {
    console.error("Erro da Alexa:", error);

    return handlerInput.responseBuilder
      .speak(
        "Desculpe, ocorreu um erro ao consultar seus dados financeiros."
      )
      .getResponse();
  },
};

const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    ConsultarSaldoIntentHandler,
    ResumoFinanceiroIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

const adapter = new ExpressAdapter(skill, true, true);

app.get("/", (req, res) => {
  res.status(200).json({
    online: true,
    servico: "Aurora API",
    firebase: true,
    mensagem: "Aurora está funcionando.",
  });
});

app.get("/firebase-status", async (req, res) => {
  try {
    const usuarioDoc = await db.collection("usuarios").doc(userUid).get();

    res.status(200).json({
      firebase: true,
      uidConfigurado: true,
      documentoUsuarioEncontrado: usuarioDoc.exists,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      firebase: false,
      erro: error.message,
    });
  }
});

app.post("/alexa", adapter.getRequestHandlers());

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Aurora API iniciada na porta ${port}`);
});