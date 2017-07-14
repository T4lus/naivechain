/*
HTTP API

Get blockchain:
curl http://localhost:3001/blocks

Create block:
curl - H "Content-type:application/json" --data '{"data" : "Some data to the first block"}' http://localhost:3001/mineBlock

Add peer:
curl - H "Content-type:application/json" --data '{"peer" : "ws://localhost:6001"}' http://localhost:3001/addPeer

Query connected peers:
curl http://localhost:3001/peers
*/


'use strict';

//naivechain
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");

//elliptic
var elliptic = require('elliptic');
var BN = require('bn.js');
var hash = require('hash.js');
var Signature = require('elliptic/lib/elliptic/ec/signature');


var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

class Block {
    constructor(index, previousHash, timestamp, data, nonce, hash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.nonce = nonce;
        this.hash = hash.toString();
    }
}

class Transaction {
    constructor(message, signature) {

        this.message = message;
        this.signature = signature;

    }
}



var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2,
    RESPONSE_TRANSACTION: 3
};

var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "// Regulators say 'shadow banking' has been tamed - Financial Times, Monday 3rd July 2017", 0, "4c25efcc5ee845170afd22b7287aa4d0ba5a9fd5db90a2e9f51c9043ec0ed695");
};

var difficulty = 5;

var blockchain = [getGenesisBlock()];
var transactions = [];


var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));

    app.post('/mineBlock', (req, res) => {
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });

    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });

    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });

    app.get('/newWallet', (req, res) => {        
        var curve = elliptic.curves['ed25519'];
        var ecdsa = new elliptic.ec(curve);
        var keys = ecdsa.genKeyPair();
        var pk = keys.getPublic('hex');
        var sk = keys.getPrivate('hex');
        res.send(JSON.stringify({ 'sk': sk, 'pk': pk }));
    });

    app.post('/pay', (req, res) => {

        //POST 
        //fromPK, fromIndex, toPK, toHash, amount, change

        var fromPK = req.body.fromPK;
        var fromIndex = req.body.fromIndex;
        var fromHash = CryptoJS.SHA256(fromPK).toString();  
        var toPK = req.body.toPK;
        var toHash = CryptoJS.SHA256(toPK).toString();  
        var amount = req.body.amount;
        var change = req.body.change;
        var sk = req.body.sk;
        

        var msg = {
            inputs: [{ 'fromHash': fromHash, 'fromIndex': fromIndex, 'fromPK': fromPK }],
            outputs: [{ 'toHash': toHash, 'amount': amount }, { 'toHash': fromHash, 'amount': change }]
        };

        //sign the transaction msg
        var signature = ecdsa.sign(JSON.stringify(msg), sk);

        //verify the sign
        console.log('verified signature: ' + ecdsa.verify(msg, signature, pk, 'hex'));


        //create a new transaction
        var newTransaction = new Transaction(msg, signature);

        //!!
        //addTransaction(newTransaction);

        //broadcast transaction
        broadcast(responseTransaction());
        console.log('transaction added: ' + JSON.stringify(newTransaction));
        res.send();

    });

    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));


};


var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);

};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
            case MessageType.RESPONSE_TRANSACTION:
                handleTransactionResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var generateNextBlock = (blockData) => {
    console.log(new Date().getTime() + ' mining block..');
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    //proof of work
    var nonce = 0;
    var nextHash = '';
    while (!isValidHashDifficulty(nextHash)) {
        nonce = nonce + 1;
        nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, nonce, blockData);        
    }
    console.log(new Date().getTime() + 'mined block! nonce/hash = ' + nonce + ' ' + nextHash);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nonce, nextHash);
};




var isValidHashDifficulty = (hash) => {
    return (hash.indexOf(Array(difficulty + 1).join('0')) == 0);
}

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.nonce, block.data);
};

var calculateHash = (index, previousHash, timestamp, nonce, data) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + nonce + data).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
};


var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (!isValidHashDifficulty(calculateHashForBlock(newBlock))) {
        console.log('invalid hash does not meet difficulty requirements: ' + calculateHashForBlock(newBlock));
        return false;        
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than received blockchain. Do nothing');
    }
};


var handleTransactionResponse = (message) => {

    //to do 

    /*
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than received blockchain. Do nothing');
    }
    */

};



var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({
    'type': MessageType.QUERY_LATEST
});
var queryAllMsg = () => ({
    'type': MessageType.QUERY_ALL
});
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var responseTransaction = () => ({
    'type': MessageType.RESPONSE_TRANSACTION,
    'data': JSON.stringify([transactions[transactions.length - 1]])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);

initHttpServer();
initP2PServer();

//calc genesis block hash
var calcGenesisHash = () => {
    var newb = calculateHashForBlock ( getGenesisBlock() );
    console.log('genesis hash = ' + newb);
}
calcGenesisHash();

