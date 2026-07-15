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

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

const db = getFirestore(firebaseApp, "default");

function formatarDinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function obterValorConta(dados) {
  const possibilidades = [
    dados.saldoAtual,
    dados.saldo_atual,
    dados.saldoInicial,
    dados.saldo_inicial,
    dados.saldo,
    dados.valor,
    dados.balance,
  ];

  for (const valor of possibilidades) {
    const numero = Number(valor);

    if (Number.isFinite(numero)) {
      return numero;
    }
  }

  return 0;
}

async function obterResumoDasContas() {
  const usuarioRef = db.collection("users").doc(userUid);
  const usuarioDoc = await usuarioRef.get();

  if (!usuarioDoc.exists) {
    return {
      usuarioEncontrado: false,
      quantidadeContas: 0,
      saldoTotal: 0,
    };
  }

  const contasSnapshot = await usuarioRef.collection("contas").get();

  let saldoTotal = 0;

  contasSnapshot.forEach((documento) => {
    saldoTotal += obterValorConta(documento.data());
  });

  return {
    usuarioEncontrado: true,
    quantidadeContas: contasSnapshot.size,
    saldoTotal,
  };
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "LaunchRequest"
    );
  },

  handle(handlerInput) {
    const resposta =
      "Olá! Eu sou a Aurora, assistente do Minha Vida Financeira. " +
      "Você pode pedir seu saldo ou um resumo financeiro.";

    return handlerInput.responseBuilder
      .speak(resposta)
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
    const resumo = await obterResumoDasContas();

    if (!resumo.usuarioEncontrado) {
      return handlerInput.responseBuilder
        .speak(
          "A conexão com o Firebase funcionou, mas não encontrei seu usuário."
        )
        .getResponse();
    }

    if (resumo.quantidadeContas === 0) {
      return handlerInput.responseBuilder
        .speak(
          "Encontrei seu usuário, mas ainda não existem contas cadastradas."
        )
        .getResponse();
    }

    const palavraConta =
      resumo.quantidadeContas === 1 ? "conta" : "contas";

    return handlerInput.responseBuilder
      .speak(
        `Seu saldo total é de ${formatarDinheiro(resumo.saldoTotal)}, ` +
          `somando ${resumo.quantidadeContas} ${palavraConta}.`
      )
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

  async handle(handlerInput) {
    const resumo = await obterResumoDasContas();

    if (!resumo.usuarioEncontrado) {
      return handlerInput.responseBuilder
        .speak("Não encontrei seu cadastro financeiro.")
        .getResponse();
    }

    if (resumo.quantidadeContas === 0) {
      return handlerInput.responseBuilder
        .speak("Você ainda não possui contas cadastradas.")
        .getResponse();
    }

    return handlerInput.responseBuilder
      .speak(
        `Seu resumo financeiro está disponível. ` +
          `Você possui ${resumo.quantidadeContas} contas, ` +
          `com saldo total de ${formatarDinheiro(resumo.saldoTotal)}.`
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

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "AMAZON.FallbackIntent"
    );
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "Ainda não entendi esse comando. Você pode perguntar qual é seu saldo."
      )
      .reprompt("O que deseja consultar?")
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
    CancelAndStopIntentHandler,
    FallbackIntentHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

const adapter = new ExpressAdapter(skill, true, true);

app.get("/", (req, res) => {
  res.status(200).json({
    online: true,
    servico: "Aurora API",
    firebaseInicializado: true,
    projeto: serviceAccount.project_id,
    banco: "default",
    mensagem: "Aurora está funcionando.",
  });
});

app.get("/firebase-status", async (req, res) => {
  try {
    const resumo = await obterResumoDasContas();

    res.status(200).json({
      firebase: true,
      projeto: serviceAccount.project_id,
      banco: "default",
      uidConfigurado: true,
      uid: userUid,
      documentoUsuarioEncontrado: resumo.usuarioEncontrado,
      quantidadeContas: resumo.quantidadeContas,
      saldoTotal: resumo.saldoTotal,
      saldoTotalFormatado: formatarDinheiro(resumo.saldoTotal),
    });
  } catch (error) {
    console.error("Erro no Firebase:", error);

    res.status(500).json({
      firebase: false,
      codigo: error.code || null,
      erro: error.message,
      projeto: serviceAccount.project_id,
      banco: "default",
    });
  }
});

app.post("/alexa", adapter.getRequestHandlers());

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Aurora API iniciada na porta ${port}`);
  console.log(`Projeto Firebase: ${serviceAccount.project_id}`);
  console.log("Banco Firestore: default");
});
