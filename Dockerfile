FROM node:8

RUN wget https://cmake.org/files/v3.6/cmake-3.6.2-Linux-x86_64.tar.gz
RUN tar -xf cmake-3.6.2-Linux-x86_64.tar.gz

RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/cmake /usr/local/bin/cmake
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/ccmake /usr/local/bin/ccmake
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/cmake-gui /usr/local/bin/cmake-gui
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/cpack /usr/local/bin/cpack
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/ctest /usr/local/bin/ctest

RUN apt-get update && apt-get install -y postgresql-client

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

RUN npm install -g npm@6.1

COPY . /usr/src/app/
RUN npm run build
