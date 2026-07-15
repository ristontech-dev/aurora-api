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



function normalizarTexto(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function obterSlot(handlerInput, nome) {
  const slot = handlerInput.requestEnvelope?.request?.intent?.slots?.[nome];

  if (!slot) {
    return "";
  }

  const resolvido =
    slot.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name;

  return String(resolvido || slot.value || "").trim();
}

function converterValorFalado(valor) {
  if (typeof valor === "number") {
    return valor;
  }

  const limpo = String(valor || "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");

  const numero = Number(limpo);
  return Number.isFinite(numero) ? numero : 0;
}

function formatarDataMovimentacao(valorData) {
  const agora = new Date();

  if (!valorData) {
    return agora.toISOString().replace(/Z$/, "");
  }

  const texto = String(valorData).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return `${texto}T12:00:00.000`;
  }

  const convertida = new Date(texto);
  if (!Number.isNaN(convertida.getTime())) {
    return convertida.toISOString().replace(/Z$/, "");
  }

  return agora.toISOString().replace(/Z$/, "");
}

async function localizarContaPorNome(nomeInformado) {
  const termo = normalizarTexto(nomeInformado);
  const usuarioRef = db.collection("users").doc(userUid);
  const contasSnapshot = await usuarioRef.collection("contas").get();

  const contas = contasSnapshot.docs.map((documento) => ({
    id: documento.id,
    nome: obterNomeConta(documento.data(), documento.id),
    dados: documento.data(),
  }));

  if (!termo) {
    return null;
  }

  return (
    contas.find((conta) => normalizarTexto(conta.nome) === termo) ||
    contas.find((conta) => normalizarTexto(conta.nome).includes(termo)) ||
    contas.find((conta) => termo.includes(normalizarTexto(conta.nome))) ||
    null
  );
}

async function registrarMovimentacao({
  tipo,
  valor,
  categoria,
  conta,
  data,
  descricao,
}) {
  const contaEncontrada = await localizarContaPorNome(conta);

  if (!contaEncontrada) {
    const erro = new Error(`Conta ${conta || "não informada"} não encontrada.`);
    erro.codigo = "CONTA_NAO_ENCONTRADA";
    throw erro;
  }

  const movimentacoesRef = db
    .collection("users")
    .doc(userUid)
    .collection("movimentacoes");

  const documentoRef = movimentacoesRef.doc();
  const agora = Date.now();

  const dados = {
    categoria: categoria || "Outros",
    cloud_id: documentoRef.id,
    conta: contaEncontrada.nome,
    data: formatarDataMovimentacao(data),
    deleted_at: null,
    descricao: descricao || (tipo === "entrada" ? "Receita" : "Despesa"),
    owner_uid: userUid,
    tipo,
    updated_at: agora,
    valor: Number(valor),
  };

  await documentoRef.set(dados);

  return {
    id: documentoRef.id,
    ...dados,
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



function criarMovimentacaoIntentHandler(nomeIntent, tipo) {
  return {
    canHandle(handlerInput) {
      return (
        Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
        Alexa.getIntentName(handlerInput.requestEnvelope) === nomeIntent
      );
    },

    async handle(handlerInput) {
      const valorFalado = obterSlot(handlerInput, "valor");
      const categoria = obterSlot(handlerInput, "categoria") || "Outros";
      const conta = obterSlot(handlerInput, "conta");
      const data = obterSlot(handlerInput, "data");
      const descricao = obterSlot(handlerInput, "descricao");
      const valor = converterValorFalado(valorFalado);

      if (!valor || valor <= 0) {
        return handlerInput.responseBuilder
          .speak("Não consegui entender o valor. Diga, por exemplo, cinquenta reais.")
          .reprompt("Qual é o valor da movimentação?")
          .getResponse();
      }

      if (!conta) {
        return handlerInput.responseBuilder
          .speak("Em qual conta devo registrar essa movimentação?")
          .reprompt("Diga o nome da conta, por exemplo, Carteira ou PagBank.")
          .getResponse();
      }

      try {
        const movimentacao = await registrarMovimentacao({
          tipo,
          valor,
          categoria,
          conta,
          data,
          descricao,
        });

        const palavra = tipo === "entrada" ? "Receita" : "Despesa";

        return handlerInput.responseBuilder
          .speak(
            `${palavra} de ${formatarDinheiro(movimentacao.valor)} ` +
              `registrada na conta ${movimentacao.conta}` +
              `${movimentacao.descricao ? `, com a descrição ${movimentacao.descricao}` : ""}.`
          )
          .getResponse();
      } catch (error) {
        console.error(`Erro ao registrar ${tipo}:`, error);

        if (error.codigo === "CONTA_NAO_ENCONTRADA") {
          return handlerInput.responseBuilder
            .speak(
              `Não encontrei a conta ${conta}. ` +
                "Confira o nome da conta e tente novamente."
            )
            .getResponse();
        }

        throw error;
      }
    },
  };
}

const AdicionarDespesaIntentHandler = criarMovimentacaoIntentHandler(
  "AdicionarDespesaIntent",
  "saida"
);

const AdicionarReceitaIntentHandler = criarMovimentacaoIntentHandler(
  "AdicionarReceitaIntent",
  "entrada"
);

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
    AdicionarDespesaIntentHandler,
    AdicionarReceitaIntentHandler,
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
      movimentacoesHabilitadas: true,
      intentsGravacao: ["AdicionarDespesaIntent", "AdicionarReceitaIntent"],
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
