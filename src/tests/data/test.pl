use strict;
use warnings;
use HTTP::Request;
use HTTP::Headers;
use LWP::UserAgent;

our $dbname;
our $dbpass;
my $logfile;
require './dbconfig.pl';

my %grades;
$grades{"Foo Bar"}{'Mathematics'}         = 97;
$grades{"Bar Foo"}{'Literature'}          = 88;
$grades{"Bar Foo"}{1}                     = "123123";
$grades{"Bar Foo"}{'Art'}{'asdasdasdasd'} = HTTP::Headers->new();
my @list = (1, 2, 3, "test");
my $req = HTTP::Request->new( 'GET', 'https://jsonplaceholder.typicode.com/todos', HTTP::Headers->new('accept' => 'application/json') );
my $res = LWP::UserAgent->new()->send_request($req);
open($logfile, '>>', 'test.log');
print $res . "\n";