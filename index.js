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

function obterNomeConta(dados, documentoId) {
  const possibilidades = [
    dados.nome,
    dados.nomeConta,
    dados.nome_conta,
    dados.instituicao,
    dados.banco,
    dados.descricao,
  ];

  for (const valor of possibilidades) {
    if (typeof valor === "string" && valor.trim()) {
      return valor.trim();
    }
  }

  return `Conta ${documentoId.slice(0, 5)}`;
}

async function obterResumoDasContas() {
  const usuarioRef = db.collection("users").doc(userUid);
  const usuarioDoc = await usuarioRef.get();

  if (!usuarioDoc.exists) {
    return {
      usuarioEncontrado: false,
      quantidadeContas: 0,
      saldoTotal: 0,
      contas: [],
    };
  }

  const contasSnapshot = await usuarioRef.collection("contas").get();

  let saldoTotal = 0;
  const contas = [];

  contasSnapshot.forEach((documento) => {
    const dados = documento.data();
    const saldo = obterValorConta(dados);
    const nome = obterNomeConta(dados, documento.id);

    saldoTotal += saldo;

    contas.push({
      id: documento.id,
      nome,
      saldo,
    });
  });

  contas.sort((a, b) => b.saldo - a.saldo);

  return {
    usuarioEncontrado: true,
    quantidadeContas: contas.length,
    saldoTotal,
    contas,
  };
}


function obterNomeCartao(dados, documentoId) {
  const possibilidades = [
    dados.nome,
    dados.nome_cartao,
    dados.nomeCartao,
    dados.instituicao,
    dados.banco,
  ];

  for (const valor of possibilidades) {
    if (typeof valor === "string" && valor.trim()) {
      return valor.trim();
    }
  }

  return `Cartão ${documentoId.slice(0, 5)}`;
}

function obterNumero(valor, padrao = 0) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : padrao;
}

async function obterResumoDosCartoes() {
  const usuarioRef = db.collection("users").doc(userUid);
  const usuarioDoc = await usuarioRef.get();

  if (!usuarioDoc.exists) {
    return {
      usuarioEncontrado: false,
      quantidadeCartoes: 0,
      quantidadeCartoesAtivos: 0,
      limiteTotal: 0,
      cartoes: [],
    };
  }

  const cartoesSnapshot = await usuarioRef.collection("cartoes").get();

  let limiteTotal = 0;
  const cartoes = [];

  cartoesSnapshot.forEach((documento) => {
    const dados = documento.data();

    if (dados.deleted_at) {
      return;
    }

    const ativo = dados.ativo !== false;
    const nome = obterNomeCartao(dados, documento.id);
    const bandeira =
      typeof dados.bandeira === "string" && dados.bandeira.trim()
        ? dados.bandeira.trim()
        : "bandeira não informada";

    const limite = obterNumero(dados.limite);
    const diaFechamento = obterNumero(
      dados.dia_fechamento ?? dados.diaFechamento
    );
    const diaVencimento = obterNumero(
      dados.dia_vencimento ?? dados.diaVencimento
    );

    if (ativo) {
      limiteTotal += limite;
    }

    cartoes.push({
      id: documento.id,
      nome,
      bandeira,
      limite,
      diaFechamento,
      diaVencimento,
      ativo,
    });
  });

  cartoes.sort((a, b) => b.limite - a.limite);

  return {
    usuarioEncontrado: true,
    quantidadeCartoes: cartoes.length,
    quantidadeCartoesAtivos: cartoes.filter((cartao) => cartao.ativo).length,
    limiteTotal,
    cartoes,
  };
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "LaunchRequest"
    );
  },

  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "Olá! Eu sou a Aurora, assistente do Minha Vida Financeira. " +
          "Você pode pedir seu saldo, perguntar quanto tem em cada conta " +
          "ou solicitar um resumo financeiro."
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

const ConsultarContasIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "ConsultarContasIntent"
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

    const detalhes = resumo.contas
      .map(
        (conta) =>
          `${conta.nome}, com saldo de ${formatarDinheiro(conta.saldo)}`
      )
      .join(". ");

    return handlerInput.responseBuilder
      .speak(
        `Você possui ${resumo.quantidadeContas} contas. ${detalhes}.`
      )
      .getResponse();
  },
};


const ConsultarCartoesIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) ===
        "ConsultarCartoesIntent"
    );
  },

  async handle(handlerInput) {
    const resumo = await obterResumoDosCartoes();

    if (!resumo.usuarioEncontrado) {
      return handlerInput.responseBuilder
        .speak("Não encontrei seu cadastro financeiro.")
        .getResponse();
    }

    if (resumo.quantidadeCartoes === 0) {
      return handlerInput.responseBuilder
        .speak("Você ainda não possui cartões cadastrados.")
        .getResponse();
    }

    const detalhes = resumo.cartoes
      .map((cartao) => {
        const situacao = cartao.ativo ? "" : " Este cartão está inativo.";

        return (
          `${cartao.nome}, da bandeira ${cartao.bandeira}, ` +
          `com limite de ${formatarDinheiro(cartao.limite)}. ` +
          `A fatura fecha no dia ${cartao.diaFechamento} ` +
          `e vence no dia ${cartao.diaVencimento}.${situacao}`
        );
      })
      .join(" ");

    const palavraCartao =
      resumo.quantidadeCartoes === 1 ? "cartão" : "cartões";

    return handlerInput.responseBuilder
      .speak(
        `Você possui ${resumo.quantidadeCartoes} ${palavraCartao}. ${detalhes}`
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

    const maiorConta = resumo.contas[0];

    return handlerInput.responseBuilder
      .speak(
        `Seu resumo financeiro está disponível. ` +
          `Você possui ${resumo.quantidadeContas} contas, ` +
          `com saldo total de ${formatarDinheiro(resumo.saldoTotal)}. ` +
          `A conta com maior saldo é ${maiorConta.nome}, ` +
          `com ${formatarDinheiro(maiorConta.saldo)}.`
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
        "Você pode dizer: qual é meu saldo, quanto tenho em cada conta, " +
          "quais cartões eu tenho, qual é o limite do meu cartão, " +
          "ou faça um resumo financeiro."
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
        "Ainda não entendi esse comando. " +
          "Você pode perguntar qual é seu saldo, quanto tem em cada conta " +
          "ou quais cartões possui."
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
    ConsultarContasIntentHandler,
    ConsultarCartoesIntentHandler,
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
      contas: resumo.contas.map((conta) => ({
        nome: conta.nome,
        saldo: conta.saldo,
        saldoFormatado: formatarDinheiro(conta.saldo),
      })),
      ...(await (async () => {
        const cartoes = await obterResumoDosCartoes();
        return {
          quantidadeCartoes: cartoes.quantidadeCartoes,
          quantidadeCartoesAtivos: cartoes.quantidadeCartoesAtivos,
          limiteTotalCartoes: cartoes.limiteTotal,
          limiteTotalCartoesFormatado: formatarDinheiro(cartoes.limiteTotal),
          cartoes: cartoes.cartoes.map((cartao) => ({
            nome: cartao.nome,
            bandeira: cartao.bandeira,
            limite: cartao.limite,
            limiteFormatado: formatarDinheiro(cartao.limite),
            diaFechamento: cartao.diaFechamento,
            diaVencimento: cartao.diaVencimento,
            ativo: cartao.ativo,
          })),
        };
      })()),
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
